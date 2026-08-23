import { Request } from "express";

function headerString(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
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

export function credentialsFromRequest(req: Request): {
  workspaceId: string;
  apiKey: string;
  schema: any;
} {
  const body = (req.body ?? {}) as {
    workspaceId?: unknown;
    apiKey?: unknown;
    schema?: any;
  };
  return {
    workspaceId: workspaceIdFromRequest(body),
    apiKey: apiKeyFromRequest(req, body),
    schema: body.schema,
  };
}
