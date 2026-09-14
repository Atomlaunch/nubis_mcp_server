import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNubisMcpServer, type ToolExecutor } from "../src/tools.js";
import { allowsEndpoint, allowsTool } from "./remote-policy.js";
import { RemoteAuthError, type RemotePrincipal } from "./remote-auth.js";

export type RemoteMcpConfig = {
  resource: string;
  issuer: string;
  allowedOrigins?: string[];
  scopesSupported?: string[];
  authorize: (token: string) => Promise<RemotePrincipal>;
  execute: (
    principal: RemotePrincipal,
    request: Parameters<ToolExecutor>[0],
  ) => ReturnType<ToolExecutor>;
};

export function validatePublicUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MCP URLs must use HTTPS (HTTP is allowed only on localhost), without credentials, query, or fragment",
    );
  }
  return url;
}

/** Stateless, per-request servers: no cross-user session cache or global credentials. */
export function registerRemoteMcp(app: Express, config: RemoteMcpConfig): void {
  const resource = validatePublicUrl(config.resource);
  validatePublicUrl(config.issuer);
  if (resource.pathname !== "/mcp")
    throw new Error("MCP resource URL must end in /mcp");
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource/mcp`;
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  for (const origin of allowedOrigins) {
    if (validatePublicUrl(origin).origin !== origin)
      throw new Error("MCP allowed origins must be exact origins");
  }
  const metadata = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    // Supabase supports standard OIDC scopes, not arbitrary application scopes.
    // Task permissions are approved separately and bound into the signed grant.
    scopes_supported: config.scopesSupported ?? ["openid"],
    bearer_methods_supported: ["header"],
    resource_name: "Nubis workspace tasks",
  };
  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(metadata);
    },
  );

  function originAllowed(req: Request, res: Response): boolean {
    // Config, not forwarded/Host headers, is the authority for discovery and redirects.
    if (req.get("host") !== resource.host) {
      res.status(403).json({ error: "Host is not allowed" });
      return false;
    }
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Origin is not allowed" });
      return false;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Protocol-Version",
      );
    }
    return true;
  }
  app.options("/mcp", (req, res) => {
    if (!originAllowed(req, res)) return;
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, MCP-Protocol-Version",
    );
    res.status(204).end();
  });

  app.all("/mcp", async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    if (!originAllowed(req, res)) return;
    if (!["POST", "GET", "DELETE"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET, DELETE, OPTIONS");
      res.status(405).end();
      return;
    }
    const bearer = /^Bearer ([^\s,]+)$/i.exec(
      req.get("authorization") ?? "",
    )?.[1];
    try {
      if (!bearer) throw new RemoteAuthError(401, "Sign in to connect Nubis");
      const principal = await config.authorize(bearer);
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        res.status(405).end();
        return;
      }
      // No request-supplied workspace or user identity can override this principal.
      const server = createNubisMcpServer(
        async (request) => {
          // Recheck revocation/membership at the action boundary, not only initialization.
          const current = await config.authorize(bearer);
          if (
            current.grantId !== principal.grantId ||
            current.userId !== principal.userId ||
            current.workspaceId !== principal.workspaceId ||
            !allowsEndpoint(current.scopes, request.endpoint)
          )
            throw new Error("This connection does not permit that tool");
          return config.execute(current, request);
        },
        (name) => allowsTool(principal.scopes, name),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof RemoteAuthError ? error.status : 500;
      if (status === 401)
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadataUrl}"`,
        );
      res.status(status).json({
        error:
          error instanceof RemoteAuthError
            ? error.message
            : "MCP request failed",
      });
    }
  });
}
