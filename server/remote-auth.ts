import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { MCP_SCOPES, type McpScope } from "./remote-policy.js";

export class RemoteAuthError extends Error {
  constructor(
    public readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
  }
}

export type WorkspaceGrant = {
  id: string;
  user_id: string;
  client_id: string;
  workspace_id: string;
  scopes: string[];
  revoked_at: string | null;
  expires_at: string;
};
export type RemotePrincipal = {
  accessToken: string;
  userId: string;
  clientId: string;
  workspaceId: string;
  grantId: string;
  scopes: McpScope[];
  expiresAt: number;
  actions?: string[];
};
export type GrantLookup = (
  token: string,
  grantId: string,
) => Promise<WorkspaceGrant | null>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Legacy direct-provider verifier retained for regression tests only.
 * Production wiring uses the approved broker in remote-config.ts.
 * Generic Supabase user tokens are deliberately insufficient here.
 */
export function createRemoteAuthorizer(config: {
  issuer: string;
  resource: string;
  jwks: URL;
  lookupGrant: GrantLookup;
  isHumanMember: (
    token: string,
    workspaceId: string,
    userId: string,
  ) => Promise<boolean>;
  // Inject local keys and clock for isolated cryptographic integration tests.
  key?: JWTVerifyGetKey;
  now?: () => number;
}) {
  const key =
    config.key ?? createRemoteJWKSet(config.jwks, { timeoutDuration: 5000 });
  const now = config.now ?? Date.now;
  return async (accessToken: string): Promise<RemotePrincipal> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(accessToken, key, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["ES256", "RS256"],
        requiredClaims: [
          "exp",
          "iat",
          "sub",
          "client_id",
          "role",
          "mcp_grant_id",
          "mcp_workspace_id",
        ],
        currentDate: new Date(now()),
      }));
    } catch {
      throw new RemoteAuthError(401, "Invalid or expired MCP access token");
    }
    const {
      sub,
      client_id: clientId,
      mcp_grant_id: grantId,
      mcp_workspace_id: workspaceId,
    } = payload;
    // A dedicated, least-privileged PostgREST role prevents broad direct API access.
    if (
      payload.role !== "nubis_mcp" ||
      payload.aud !== config.resource ||
      typeof payload.iat !== "number" ||
      payload.iat > now() / 1000 + 60 ||
      typeof sub !== "string" ||
      !uuid.test(sub) ||
      typeof clientId !== "string" ||
      !clientId ||
      typeof grantId !== "string" ||
      !uuid.test(grantId) ||
      typeof workspaceId !== "string" ||
      !uuid.test(workspaceId) ||
      !Array.isArray(payload.mcp_scopes) ||
      !payload.mcp_scopes.every((scope: unknown) => typeof scope === "string")
    ) {
      throw new RemoteAuthError(
        401,
        "Token is not a workspace-bound MCP grant",
      );
    }
    let grant: WorkspaceGrant | null;
    let member: boolean;
    try {
      grant = await config.lookupGrant(accessToken, grantId);
      member = grant
        ? await config.isHumanMember(accessToken, workspaceId, sub)
        : false;
    } catch {
      throw new RemoteAuthError(
        503,
        "MCP authorization is temporarily unavailable",
      );
    }
    if (
      !grant ||
      grant.id !== grantId ||
      grant.user_id !== sub ||
      grant.client_id !== clientId ||
      grant.workspace_id !== workspaceId ||
      grant.revoked_at !== null ||
      !Number.isFinite(Date.parse(grant.expires_at)) ||
      Date.parse(grant.expires_at) <= now() ||
      !member
    ) {
      throw new RemoteAuthError(
        403,
        "Connection revoked or workspace access unavailable",
      );
    }
    // Application permissions are separate from Supabase's standard OIDC scopes.
    const requestedScopes = payload.mcp_scopes;
    if (!Array.isArray(grant.scopes))
      throw new RemoteAuthError(403, "Invalid connection permissions");
    const scopes = MCP_SCOPES.filter(
      (scope) =>
        requestedScopes.includes(scope) && grant.scopes.includes(scope),
    );
    if (!scopes.includes("nubis.tasks.read"))
      throw new RemoteAuthError(403, "Task read permission is required");
    return {
      accessToken,
      userId: sub,
      clientId,
      workspaceId,
      grantId,
      scopes,
      expiresAt: Math.min(payload.exp!, Date.parse(grant.expires_at) / 1000),
    };
  };
}
