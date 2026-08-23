import { Request } from "express";

export type DeleteTaskBody = {
  workspaceId?: unknown;
  apiKey?: unknown;
  schema?: any;
  taskID?: unknown;
  taskIDs?: unknown;
};

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
} {
  const body = (req.body ?? {}) as DeleteTaskBody;
  return {
    workspaceId: workspaceIdFromRequest(body),
    apiKey: apiKeyFromRequest(req, body),
    schema: body.schema,
  };
}
