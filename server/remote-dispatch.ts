import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolExecutor } from "../src/tools.js";
import type { RemotePrincipal } from "./remote-auth.js";
import { allowsEndpoint } from "./remote-policy.js";

type Handler = (req: Request, res: Response) => Promise<void>;
export type RemoteRequestAuth = {
  ok: true;
  authKind: "human_oauth";
  workspaceId: string;
  schema: any;
  api_usage: null;
  userId: string;
  role: null;
  db: SupabaseClient;
  accessToken: string;
};

/** Object identity only: neither HTTP headers nor JSON can inject this context. */
const trustedRequests = new WeakMap<Request, RemoteRequestAuth>();
export function remoteRequestAuth(req: Request): RemoteRequestAuth | undefined {
  return trustedRequests.get(req);
}

export function createRemoteDispatcher(
  dbForToken: (token: string) => SupabaseClient,
) {
  const handlers = new Map<string, Handler>();
  function register(
    app: Express,
    paths: string | string[],
    handler: Handler,
  ): void {
    app.post(paths, handler);
    for (const path of Array.isArray(paths) ? paths : [paths])
      handlers.set(path.slice(1), handler);
  }
  async function execute(
    principal: RemotePrincipal,
    request: Parameters<ToolExecutor>[0],
  ): ReturnType<ToolExecutor> {
    if (!allowsEndpoint(principal.scopes, request.endpoint))
      throw new Error("Tool is not permitted for this connection");
    const handler = handlers.get(request.endpoint);
    if (!handler) throw new Error("Tool is not available");
    const input = request.schema;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid tool arguments");
    for (const key of [
      "workspaceId",
      "workspace_id",
      "userId",
      "accessToken",
      "apiKey",
    ]) {
      if (key in input)
        throw new Error(
          "Connection identity cannot be supplied as a tool argument",
        );
    }
    // Match the legacy HTTP JSON boundary: omitted optional fields must not become
    // explicit clears in handlers that check own-property presence. Keep nulls.
    const schema = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const db = dbForToken(principal.accessToken);
    // User RLS may allow several workspaces. Validate foreign-key references against
    // this connection's workspace before reusing legacy handlers for writes.
    await Promise.all(
      ["taskID", "parent_task_id"].map(async (key) => {
        if (!schema[key]) return;
        const { data, error } = await db
          .from("pm_tasks")
          .select("id")
          .eq("id", schema[key])
          .eq("project_id", principal.workspaceId)
          .maybeSingle();
        if (error || !data)
          throw new Error("Task is unavailable in this workspace");
      }),
    );
    if (request.endpoint === "add_comment" && schema.parent_id) {
      const { data, error } = await db
        .from("pm_comments")
        .select("id")
        .eq("id", schema.parent_id)
        .eq("project_id", principal.workspaceId)
        .eq("task_id", schema.taskID)
        .maybeSingle();
      if (error || !data)
        throw new Error("Parent comment is unavailable in this task");
    }
    // Existing task handlers use only body/headers and status().json(). Keeping this
    // adapter in-process avoids forwarding bearer tokens or looping through HTTP.
    const req = {
      body: { schema, workspaceId: principal.workspaceId },
      headers: {},
    } as Request;
    trustedRequests.set(req, {
      ok: true,
      authKind: "human_oauth",
      workspaceId: principal.workspaceId,
      schema,
      api_usage: null,
      userId: principal.userId,
      role: null,
      db,
      accessToken: principal.accessToken,
    });
    let status = 200;
    let result: any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        result = body;
        return this;
      },
    } as Response;
    await handler(req, res);
    if (status >= 400)
      throw new Error("Nubis could not complete this task operation");
    if (!result || !("data" in result))
      throw new Error("Task operation returned no result");
    return { data: result.data, api_usage: result.api_usage };
  }
  return { register, execute };
}
