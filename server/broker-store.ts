import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { errors, type AdapterPayload } from "oidc-provider";

export type UpstreamSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
};
export type BrokerConnection = {
  grantId: string;
  interactionId: string;
  userId: string;
  clientId: string;
  workspaceId: string;
  clientName: string;
  workspaceName: string;
  scopes: string[];
  session: UpstreamSession;
  expiresAt: number;
  revokedAt: string | null;
};
export type ListedConnection = {
  grant_id: string;
  client_name: string;
  workspace_id: string;
  workspace_name: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date;
};

/** Auth artifacts and upstream refresh tokens are encrypted, including backups. */
export class BrokerStore {
  constructor(
    readonly pool: Pool,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32)
      throw new Error("Broker encryption key must contain 32 random bytes");
  }
  private seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }
  private open<T>(value: string, context: string): T {
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  }
  async ready(): Promise<void> {
    await this.pool.query(
      "select grant_id, refresh_pending from nubis_broker.connections limit 0",
    );
    await this.pool.query("select id from nubis_broker.artifacts limit 0");
  }
  adapter = (kind: string) => ({
    upsert: async (id: string, payload: AdapterPayload, expiresIn?: number) => {
      await this.pool.query(
        `insert into nubis_broker.artifacts(kind,id,payload,grant_id,uid,user_code,expires_at)
        values($1,$2,$3,$4,$5,$6,case when $7::integer is null then 'infinity'::timestamptz else now()+$7*interval '1 second' end)
        on conflict(kind,id) do update set payload=excluded.payload,expires_at=excluded.expires_at
        where nubis_broker.artifacts.revoked_at is null`,
        [
          kind,
          id,
          this.seal(payload, `${kind}:${id}`),
          payload.grantId ?? null,
          payload.uid ?? null,
          payload.userCode ?? null,
          expiresIn ?? null,
        ],
      );
    },
    find: (id: string) => this.findArtifact(kind, "id", id),
    findByUid: (uid: string) => this.findArtifact(kind, "uid", uid),
    findByUserCode: (code: string) =>
      this.findArtifact(kind, "user_code", code),
    consume: async (id: string) => {
      const result = await this.pool.query(
        `update nubis_broker.artifacts set consumed_at=now()
        where kind=$1 and id=$2 and consumed_at is null and revoked_at is null and expires_at>now()`,
        [kind, id],
      );
      if (result.rowCount !== 1)
        throw new errors.InvalidGrant(
          "Authorization artifact already consumed",
        );
    },
    // Soft revocation preserves audit evidence; no user records are deleted.
    destroy: async (id: string) => {
      await this.pool.query(
        "update nubis_broker.artifacts set revoked_at=coalesce(revoked_at,now()) where kind=$1 and id=$2",
        [kind, id],
      );
    },
    revokeByGrantId: async (grantId: string) => {
      await this.revoke(grantId);
    },
  });
  private async findArtifact(
    kind: string,
    field: "id" | "uid" | "user_code",
    value: string,
  ): Promise<AdapterPayload | undefined> {
    const { rows } = await this.pool.query(
      `select id,payload,consumed_at from nubis_broker.artifacts
      where kind=$1 and ${field}=$2 and revoked_at is null and expires_at>now()`,
      [kind, value],
    );
    if (!rows.length) return undefined;
    const payload = this.open<AdapterPayload>(
      rows[0].payload,
      `${kind}:${rows[0].id}`,
    );
    if (rows[0].consumed_at)
      payload.consumed = Math.floor(
        new Date(rows[0].consumed_at).getTime() / 1000,
      );
    return payload;
  }
  async saveConnection(connection: BrokerConnection): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const previous = await client.query(
        `select grant_id from nubis_broker.connections
         where user_id=$1 and client_id=$2 and workspace_id=$3
           and grant_id<>$4 and revoked_at is null
         for update`,
        [
          connection.userId,
          connection.clientId,
          connection.workspaceId,
          connection.grantId,
        ],
      );
      const previousIds = previous.rows.map((row: { grant_id: string }) => row.grant_id);
      if (previousIds.length) {
        await client.query(
          `update nubis_broker.connections set revoked_at=coalesce(revoked_at,now())
           where grant_id=any($1::text[])`,
          [previousIds],
        );
        await client.query(
          `update nubis_broker.artifacts set revoked_at=coalesce(revoked_at,now())
           where grant_id=any($1::text[]) or (kind='Grant' and id=any($1::text[]))`,
          [previousIds],
        );
      }
      await client.query(
        `insert into nubis_broker.connections
        (grant_id,interaction_id,user_id,client_id,workspace_id,client_name,workspace_name,scopes,upstream_session,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10))`,
        [
          connection.grantId,
          connection.interactionId,
          connection.userId,
          connection.clientId,
          connection.workspaceId,
          connection.clientName,
          connection.workspaceName,
          connection.scopes,
          this.seal(connection.session, connection.grantId),
          connection.expiresAt,
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async connection(grantId: string): Promise<BrokerConnection | null> {
    const { rows } = await this.pool.query(
      "select * from nubis_broker.connections where grant_id=$1 and revoked_at is null and expires_at>now()",
      [grantId],
    );
    return rows.length ? this.fromRow(rows[0]) : null;
  }
  private fromRow(row: any): BrokerConnection {
    return {
      grantId: row.grant_id,
      interactionId: row.interaction_id,
      userId: row.user_id,
      clientId: row.client_id,
      workspaceId: row.workspace_id,
      clientName: row.client_name,
      workspaceName: row.workspace_name,
      scopes: row.scopes,
      session: this.open(row.upstream_session, row.grant_id),
      expiresAt: new Date(row.expires_at).getTime() / 1000,
      revokedAt: row.revoked_at,
    };
  }
  async list(userId: string, clientId?: string): Promise<ListedConnection[]> {
    const { rows } = await this.pool.query<ListedConnection>(
      clientId
        ? `select grant_id,client_name,workspace_id,workspace_name,scopes,created_at,expires_at
           from nubis_broker.connections
           where user_id=$1 and client_id=$2 and revoked_at is null and expires_at>now()
           order by created_at desc`
        : `select grant_id,client_name,workspace_id,workspace_name,scopes,created_at,expires_at
           from nubis_broker.connections
           where user_id=$1 and revoked_at is null and expires_at>now()
           order by created_at desc`,
      clientId ? [userId, clientId] : [userId],
    );
    return rows; // Never return encrypted or plaintext credentials to Settings.
  }
  async revoke(grantId: string, userId?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (userId) {
        const result = await client.query(
          "select grant_id from nubis_broker.connections where grant_id=$1 and user_id=$2 for update",
          [grantId, userId],
        );
        if (!result.rowCount) throw new Error("Connection not found");
      }
      await client.query(
        "update nubis_broker.connections set revoked_at=coalesce(revoked_at,now()) where grant_id=$1",
        [grantId],
      );
      await client.query(
        "update nubis_broker.artifacts set revoked_at=coalesce(revoked_at,now()) where grant_id=$1 or (kind='Grant' and id=$1)",
        [grantId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  /** Durable refresh marker + session advisory lock prevents retries after a crash. */
  async withSession(
    grantId: string,
    refresh: (session: UpstreamSession) => Promise<UpstreamSession>,
  ): Promise<BrokerConnection | null> {
    const client = await this.pool.connect();
    let locked = false;
    const revokeUncertain = async () => {
      await client.query("begin");
      try {
        await client.query(
          "update nubis_broker.connections set revoked_at=coalesce(revoked_at,now()) where grant_id=$1",
          [grantId],
        );
        await client.query(
          "update nubis_broker.artifacts set revoked_at=coalesce(revoked_at,now()) where grant_id=$1 or (kind='Grant' and id=$1)",
          [grantId],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    };
    try {
      await client.query("select pg_advisory_lock(hashtextextended($1,0))", [
        grantId,
      ]);
      locked = true;
      const { rows } = await client.query(
        "select * from nubis_broker.connections where grant_id=$1 and revoked_at is null and expires_at>now()",
        [grantId],
      );
      if (!rows.length) return null;
      if (rows[0].refresh_pending) {
        await revokeUncertain();
        return null;
      }
      const connection = this.fromRow(rows[0]);
      if (connection.session.expiresAt < Date.now() / 1000 + 60) {
        const marked = await client.query(
          "update nubis_broker.connections set refresh_pending=true where grant_id=$1 and revoked_at is null",
          [grantId],
        );
        if (!marked.rowCount) return null;
        try {
          connection.session = await refresh(connection.session);
          if (connection.session.userId !== connection.userId)
            throw new Error("Upstream identity changed");
        } catch {
          await revokeUncertain();
          throw new Error("Nubis sign-in expired. Reconnect this workspace.");
        }
        const updated = await client.query(
          "update nubis_broker.connections set upstream_session=$2,refresh_pending=false where grant_id=$1 and revoked_at is null",
          [grantId, this.seal(connection.session, grantId)],
        );
        if (!updated.rowCount) return null;
      }
      return connection;
    } finally {
      let failed = false;
      if (locked)
        try {
          await client.query(
            "select pg_advisory_unlock(hashtextextended($1,0))",
            [grantId],
          );
        } catch {
          failed = true;
        }
      client.release(failed);
    }
  }
}
