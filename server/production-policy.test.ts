import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
const url = process.env.NUBIS_POLICY_TEST_DATABASE_URL;
const frontend = process.env.NUBIS_PMTOOL_TEST_ROOT;
assert.ok(
  url && frontend,
  "Explicit local policy DB and PMTool checkout required",
);
assert.equal(new URL(url).hostname, "127.0.0.1");
assert.equal(new URL(url).pathname, "/nubis_mcp_policy_acceptance");
const pool = new Pool({ connectionString: url });
const names = [
  "20260830120000_agent_members_v1.sql",
  "20260830230000_co_owner_task_write.sql",
  "20260830250000_task_team_isolation_write_gates.sql",
];
const [agent, manager, isolation] = await Promise.all(
  names.map((name) =>
    readFile(`${frontend}/supabase/migrations/${name}`, "utf8"),
  ),
);
function extract(source: string, name: string) {
  const match = source.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    ),
  );
  assert.ok(match, `Missing source function ${name}`);
  return match[0];
}
const source =
  extract(agent, "agent_jwt_allowed") +
  "\n" +
  extract(manager, "check_permission") +
  "\n" +
  isolation.replace(/^DROP (?:TRIGGER|POLICY) [^\n]+\n/gm, "");
assert.ok(
  !/^DROP /m.test(source),
  "Fresh fixtures must use create-only policy installation",
);
const fingerprint = createHash("sha256").update(source).digest("hex");
const wid = randomUUID(),
  foreign = randomUUID(),
  teamA = randomUUID(),
  teamB = randomUUID();
const member = randomUUID(),
  other = randomUUID(),
  outsider = randomUUID(),
  revoked = randomUUID();
const managers = [
  ["owner", randomUUID()],
  ["admin", randomUUID()],
  ["co-owner", randomUUID()],
];
const ids = {
  public: randomUUID(),
  own: randomUUID(),
  hidden: randomUUID(),
  cross: randomUUID(),
  otherAssigned: randomUUID(),
  foreign: randomUUID(),
};
async function asUser<T>(
  uid: string,
  fn: (client: PoolClient) => Promise<T>,
  role = "authenticated",
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: uid, role, iat: Math.floor(Date.now() / 1000) }),
    ]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const denied = (uid: string, sql: string, args: unknown[]) =>
  assert.rejects(
    asUser(uid, (c) => c.query(sql, args)),
    (error: any) => error.code === "42501",
  );
try {
  const exists = (
    await pool.query("select to_regclass('public.policy_fixture_meta') as name")
  ).rows[0].name;
  if (!exists) {
    const base = await readFile(
      new URL("../docs/database/mcp-policy-fixture.sql", import.meta.url),
      "utf8",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(base);
      await client.query(source);
      await client.query(
        "REVOKE ALL ON FUNCTION agent_jwt_allowed() FROM PUBLIC; GRANT EXECUTE ON FUNCTION agent_jwt_allowed() TO authenticated; CREATE TABLE policy_fixture_meta(fingerprint text NOT NULL)",
      );
      await client.query("insert into policy_fixture_meta values($1)", [
        fingerprint,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else
    assert.equal(
      (await pool.query("select fingerprint from policy_fixture_meta")).rows[0]
        .fingerprint,
      fingerprint,
      "Policy source changed: review fixture setup before reusing it",
    );
  await Promise.all([
    pool.query(
      "insert into pm_members(project_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($1,$4,'member')",
      [wid, member, other, revoked],
    ),
    ...managers.map(([role, uid]) =>
      pool.query("insert into pm_members values($1,$2,$3)", [wid, uid, role]),
    ),
    pool.query(
      "insert into pm_role_permissions values($1,'member','tasks','create')",
      [wid],
    ),
    pool.query("insert into pm_team_members values($1,$2),($3,$4)", [
      teamA,
      member,
      teamB,
      other,
    ]),
    pool.query("insert into pm_agent_keys values($1,now(),null)", [revoked]),
  ]);
  await pool.query(
    `insert into pm_tasks(id,project_id,team_id,_assignee,created_by,title) values
 ($1,$7,null,null,$10,'Public unassigned'),($2,$7,$8,$11,$10,'Own team'),
 ($3,$7,$9,$12,$10,'Other team hidden'),($4,$7,$9,$11,$10,'Cross-team assigned'),
 ($5,$7,$8,$12,$10,'Visible but assigned to another'),($6,$13,null,null,$10,'Foreign workspace')`,
    [
      ids.public,
      ids.own,
      ids.hidden,
      ids.cross,
      ids.otherAssigned,
      ids.foreign,
      wid,
      teamA,
      teamB,
      managers[0][1],
      member,
      other,
      foreign,
    ],
  );
  const visible = await asUser(member, (c) =>
    c.query("select id from pm_tasks"),
  );
  assert.deepEqual(
    visible.rows.map((row) => row.id).sort(),
    [ids.public, ids.own, ids.cross, ids.otherAssigned].sort(),
  );
  assert.equal(
    (await asUser(outsider, (c) => c.query("select id from pm_tasks")))
      .rowCount,
    0,
  );
  assert.equal(
    (await asUser(member, (c) => c.query("select id from pm_tasks"), "anon"))
      .rowCount,
    0,
  );
  await Promise.all(
    managers.map(async ([role, uid]) => {
      await asUser(uid, async (c) => {
        assert.equal(
          (await c.query("select id from pm_tasks")).rowCount,
          5,
          `${role} sees own workspace only`,
        );
        assert.equal(
          (
            await c.query("update pm_tasks set title=$1 where id=$2", [
              "Manager edit",
              ids.hidden,
            ])
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await c.query(
              "insert into pm_tasks(project_id,team_id,_assignee,created_by,title) values($1,$2,$3,$4,$5)",
              [wid, teamB, other, uid, "Manager create"],
            )
          ).rowCount,
          1,
        );
      });
    }),
  );
  await asUser(member, async (c) => {
    assert.equal(
      (
        await c.query("update pm_tasks set title=$1 where id=$2", [
          "Own edit",
          ids.own,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await c.query("update pm_tasks set title=$1 where id=$2", [
          "Cross-team assignee edit",
          ids.cross,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await c.query("update pm_tasks set _assignee=$1,title=$2 where id=$3", [
          member,
          "Claimed",
          ids.public,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await c.query("update pm_tasks set _assignee=$1 where id=$2", [
          member,
          ids.otherAssigned,
        ])
      ).rowCount,
      0,
      "cannot steal another assignment",
    );
    assert.equal(
      (
        await c.query("update pm_tasks set title=$1 where id=$2", [
          "Hidden edit",
          ids.hidden,
        ])
      ).rowCount,
      0,
    );
    await c.query(
      "insert into pm_tasks(project_id,team_id,_assignee,created_by,title) values($1,$2,$3,$3,$4)",
      [wid, teamA, member, "Member create"],
    );
    await c.query(
      "insert into pm_comments(project_id,task_id,user_id,content) values($1,$2,$3,$4)",
      [wid, ids.own, member, "Visible comment"],
    );
  });
  await Promise.all([
    denied(member, "update pm_tasks set title=$1 where id=$2", [
      "Unassigned edit",
      ids.public,
    ]),
    denied(member, "update pm_tasks set context=$1 where id=$2", [
      "Unassigned context",
      ids.public,
    ]),
    denied(member, "update pm_tasks set team_id=$1 where id=$2", [
      teamB,
      ids.own,
    ]),
    denied(member, "update pm_tasks set created_by=$1 where id=$2", [
      other,
      ids.own,
    ]),
    denied(member, "update pm_tasks set _assignee=null where id=$1", [ids.own]),
    denied(
      member,
      "insert into pm_tasks(project_id,team_id,created_by,title) values($1,$2,$3,$4)",
      [wid, teamB, member, "Wrong team"],
    ),
    denied(
      member,
      "insert into pm_tasks(project_id,_assignee,created_by,title) values($1,$2,$3,$4)",
      [wid, other, member, "Foreign assignment"],
    ),
    denied(
      member,
      "insert into pm_comments(project_id,task_id,user_id,content) values($1,$2,$3,$4)",
      [wid, ids.hidden, member, "Hidden comment"],
    ),
    denied(
      member,
      "insert into pm_comments(project_id,task_id,user_id,content) values($1,$2,$3,$4)",
      [wid, ids.own, other, "Forged author"],
    ),
    denied(
      revoked,
      "insert into pm_tasks(project_id,created_by,title) values($1,$2,$3)",
      [wid, revoked, "Revoked agent"],
    ),
  ]);
  // Preserve fixture records while simulating permission and membership removal.
  await pool.query(
    "update pm_role_permissions set role='disabled-member' where project_id=$1",
    [wid],
  );
  await denied(
    member,
    "insert into pm_tasks(project_id,created_by,title) values($1,$2,$3)",
    [wid, member, "Permission removed"],
  );
  await pool.query(
    "update pm_members set project_id=$1 where project_id=$2 and user_id=$3",
    [randomUUID(), wid, member],
  );
  assert.equal(
    (await asUser(member, (c) => c.query("select id from pm_tasks"))).rowCount,
    0,
    "membership removal denies the existing principal",
  );
  console.log(
    "Source-backed task/comment policies passed: owner/admin/co-owner/member, team isolation, assignment guards, forged authors, revoked-agent writes, permission and membership removal. Supporting schema is minimal; no production writes.",
  );
} finally {
  await pool.end();
}
