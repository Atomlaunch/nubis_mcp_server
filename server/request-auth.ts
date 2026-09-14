import { Request } from "express";

export type DeleteTaskBody = {
  workspaceId?: unknown;
  apiKey?: unknown;
  schema?: any;
  taskID?: unknown;
  taskIDs?: unknown;
};

export type AuthKind = "workspace_api_key" | "agent_key" | "agent_jwt" | "human_oauth";

/** Decode only to reject OAuth tokens on legacy routes; never use this to authorize. */
export function isOAuthToken(secret: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(secret.split(".")[1] ?? "", "base64url").toString("utf8"));
    return Boolean(payload && ("client_id" in payload || "mcp_grant_id" in payload || payload.role === "nubis_mcp"));
  } catch { return false; }
}

export const AGENT_KEY_PREFIX = "nubis_ag_";

const OWNER_EQUIVALENT_ROLES = new Set(["owner", "admin"]);

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "api_key",
  "agentkey",
  "agent_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "x-api-key",
  "xapikey",
]);

function headerString(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function schemaObject(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  return schema as Record<string, unknown>;
}

export function isAgentKey(value: string): boolean {
  return value.startsWith(AGENT_KEY_PREFIX);
}

/** Compact JWT detection: three segments, header starts with eyJ. */
export function isAgentJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts[0].startsWith("eyJ");
}

export function authKindFromSecret(secret: string): AuthKind {
  if (isAgentKey(secret)) return "agent_key";
  if (isAgentJwt(secret)) return "agent_jwt";
  return "workspace_api_key";
}

/**
 * Owner-equivalent workspace ops for the workspace-key path.
 * v1 has no co-owner role. Billing owner stays `owner` on pm_projects.owner_id.
 */
export function isOwnerEquivalentRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return OWNER_EQUIVALENT_ROLES.has(role);
}

/**
 * Agent keys must never be looked up in `api_keys`.
 * Returns an error message when the secret is an agent principal key.
 */
export function agentKeyApiKeysLookupError(apiKey: string): string | null {
  if (!isAgentKey(apiKey)) return null;
  return "Agent keys (nubis_ag_) are not workspace API keys and must not be looked up in api_keys. Exchange via POST /agent-session.";
}

/**
 * Resolve apiKey from JSON body first, then Authorization: Bearer, then X-Api-Key.
 * Body contract used by the MCP client is unchanged.
 */
export function apiKeyFromRequest(
  req: Request,
  body: { apiKey?: unknown }
): string {
  if (typeof body.apiKey === "string") {
    const fromBody = body.apiKey.trim();
    if (fromBody) return fromBody;
  }

  const authorization = headerString(req.headers.authorization);
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearerMatch?.[1]) {
    const token = bearerMatch[1].trim();
    if (token) return token;
  }

  return headerString(req.headers["x-api-key"]);
}

/**
 * Resolve workspace id from JSON body. This server has no workspace header today;
 * do not invent one.
 */
export function workspaceIdFromRequest(body: { workspaceId?: unknown }): string {
  if (typeof body.workspaceId === "string") {
    const fromBody = body.workspaceId.trim();
    if (fromBody) return fromBody;
  }
  return "";
}

/**
 * MCP tools send `taskID`. The HTTP body may put that field at the top level
 * (`{ workspaceId, apiKey, taskID }`) or under the MCP wrap (`schema.taskID`).
 * Auth fields are not a substitute — only `taskID` / `schema.taskID`.
 */
export function taskIDFromBody(body: DeleteTaskBody): string {
  const fromTopLevel = nonEmptyString(body.taskID);
  if (fromTopLevel) return fromTopLevel;
  return nonEmptyString(schemaObject(body.schema)?.taskID);
}

/**
 * MCP tools send `taskIDs`. Same two locations as `taskIDFromBody`.
 * Returns undefined when neither location has an array (including missing).
 */
export function taskIDsFromBody(body: DeleteTaskBody): unknown[] | undefined {
  if (Array.isArray(body.taskIDs)) return body.taskIDs;
  const wrapped = schemaObject(body.schema)?.taskIDs;
  if (Array.isArray(wrapped)) return wrapped;
  return undefined;
}

export function credentialsFromRequest(req: Request): {
  workspaceId: string;
  apiKey: string;
  schema: any;
  authKind: AuthKind | null;
} {
  const body = (req.body ?? {}) as DeleteTaskBody;
  const apiKey = apiKeyFromRequest(req, body);
  return {
    workspaceId: workspaceIdFromRequest(body),
    apiKey,
    schema: body.schema,
    authKind: apiKey ? authKindFromSecret(apiKey) : null,
  };
}

function redactString(value: string): string {
  if (isAgentKey(value) || isAgentJwt(value)) return "[redacted]";
  return value;
}

/**
 * Strip API keys, agent keys, and JWTs before console.log of request bodies.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SECRET_FIELD_NAMES.has(key.toLowerCase()) || SECRET_FIELD_NAMES.has(normalized)) {
      out[key] = nested ? "[redacted]" : nested;
      continue;
    }
    out[key] = redactSecrets(nested);
  }
  return out;
}
