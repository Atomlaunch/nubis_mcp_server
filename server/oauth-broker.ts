import Provider, { errors, type Configuration } from "oidc-provider";
import express, { type Express, type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import rateLimit from "express-rate-limit";
import { BrokerStore, type UpstreamSession } from "./broker-store.js";
import type { BrokerIdentity, LoginAttempt } from "./broker-identity.js";
import { MCP_SCOPES } from "./remote-policy.js";
import { RemoteAuthError } from "./remote-auth.js";
import { nativeDcrClientMetadata } from "./dcr-native.js";
import { validatePublicUrl, type RemoteMcpConfig } from "./remote-mcp.js";

export type BrokerOptions = {
  issuer: string;
  resource: string;
  store: BrokerStore;
  identity: BrokerIdentity;
  cookieKeys: string[];
  jwks: NonNullable<Configuration["jwks"]>;
  appOrigin: string;
  managementOrigin?: string;
  execute: RemoteMcpConfig["execute"];
};
const ttl = 30 * 86400;
const secret = () => randomBytes(32).toString("base64url");
const equal = (left: string, right: string) =>
  left.length === right.length &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
const cookies = (req: Request) =>
  Object.fromEntries(
    (req.get("cookie") ?? "")
      .split(";")
      .map((item) => item.trim().split(/=(.*)/s).slice(0, 2)),
  );

export async function createOAuthBroker(options: BrokerOptions) {
  const issuer = validatePublicUrl(options.issuer),
    resource = validatePublicUrl(options.resource);
  if (issuer.pathname !== "/oauth" || issuer.origin !== resource.origin)
    throw new Error("Broker issuer must be /oauth on the MCP origin");
  const managementOrigin = options.managementOrigin
    ? validatePublicUrl(options.managementOrigin)
    : undefined;
  if (managementOrigin && managementOrigin.href !== `${managementOrigin.origin}/`)
    throw new Error("Management origin must be an origin");
  const { store, identity } = options;
  await store.ready();
  const provider: Provider = new Provider(issuer.href, {
    adapter: store.adapter,
    jwks: options.jwks,
    cookies: {
      keys: options.cookieKeys,
      long: {
        httpOnly: true,
        sameSite: "lax",
        secure: issuer.protocol === "https:",
      },
      short: {
        httpOnly: true,
        sameSite: "lax",
        secure: issuer.protocol === "https:",
      },
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, initialAccessToken: false },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource.href,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, target) => {
          if (target !== resource.href) throw new errors.InvalidTarget();
          return {
            scope: MCP_SCOPES.join(" "),
            audience: resource.href,
            accessTokenFormat: "opaque",
            accessTokenTTL: 300,
          };
        },
      },
    },
    pkce: { required: () => true },
    responseTypes: ["code"],
    // MCP clients include resource scopes in dynamic client registration.
    scopes: ["openid", "offline_access", ...MCP_SCOPES],
    subjectTypes: ["public"],
    clientAuthMethods: ["none"],
    extraClientMetadata: nativeDcrClientMetadata,
    clientDefaults: {
      token_endpoint_auth_method: "none",
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
    },
    ttl: {
      AccessToken: 300,
      AuthorizationCode: 60,
      Interaction: 600,
      Grant: ttl,
      Session: 3600,
      RefreshToken: ttl,
    },
    rotateRefreshToken: true,
    issueRefreshToken: () => true,
    expiresWithSession: () => false,
    findAccount: async (_ctx, id) => ({
      accountId: id,
      claims: async () => ({ sub: id }),
    }),
    interactions: {
      url: (_ctx, interaction) => `${issuer.origin}/connect/${interaction.uid}`,
    },
    // Never reuse the previous client/workspace grant from a browser session.
    loadExistingGrant: async (ctx) => {
      const id = ctx.oidc.result?.consent?.grantId;
      return id ? provider.Grant.find(id) : undefined;
    },
  });
  provider.proxy = issuer.protocol === "https:";
  const artifact = store.adapter("NubisInteraction");
  const loginArtifact = store.adapter("NubisLogin");
  type InteractionState = { csrf: string; upstream?: UpstreamSession };
  async function interaction(req: Request, res: Response) {
    const detail = await provider.interactionDetails(req, res);
    if (detail.uid !== req.params.uid)
      throw new errors.SessionNotFound("Interaction mismatch");
    const saved = (await artifact.find(detail.uid)) as
      | InteractionState
      | undefined;
    const state = saved ?? { csrf: secret() };
    if (!saved) await artifact.upsert(detail.uid, state, 600);
    return { detail, state };
  }
  function wrap(handler: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response) => {
      void handler(req, res).catch(() => {
        if (!res.headersSent)
          res.status(400).json({
            error:
              "Connection request expired or could not be completed. Start again from your MCP client.",
          });
      });
    };
  }
  function protect(req: Request, res: Response, next: () => void) {
    protectOrigins(req, res, next, [issuer.origin, options.appOrigin]);
  }
  function protectOrigins(req: Request, res: Response, next: () => void, origins: string[]) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.get("host") !== issuer.host) {
      res.status(403).end();
      return;
    }
    const origin = req.get("origin");
    if (origin && !origins.includes(origin)) {
      res.status(403).end();
      return;
    }
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    next();
  }
  function csrf(req: Request, state: InteractionState) {
    if (typeof req.body?.csrf !== "string" || !equal(req.body.csrf, state.csrf))
      throw new Error("Invalid CSRF token");
  }
  function mount(app: Express) {
    app.use("/connect", protect);
    app.use(
      "/connect",
      express.json({ limit: "16kb" }),
      express.urlencoded({ extended: false, limit: "16kb" }),
    );
    app.options(/^\/connect(?:\/.*)?$/, (_req, res) => {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).end();
    });
    app.get(
      "/connect/:uid",
      wrap(async (req, res) => {
        const { detail, state } = await interaction(req, res);
        if (req.get("accept")?.includes("text/html")) {
          res.redirect(
            303,
            `${options.appOrigin}/mcp/connect?interaction=${encodeURIComponent(detail.uid)}`,
          );
          return;
        }
        const client = await provider.Client.find(
          String(detail.params.client_id),
        );
        const workspaces = state.upstream
          ? (await identity.workspaces(state.upstream)).filter((w) =>
              w.actions.includes("read"),
            )
          : [];
        res.json({
          interactionId: detail.uid,
          clientName: client?.clientName ?? "MCP client",
          csrf: state.csrf,
          signedIn: Boolean(state.upstream),
          workspaces: workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            canWrite: w.actions.some((a) => a === "create" || a === "update"),
          })),
          requestedScopes: String(detail.params.scope ?? "")
            .split(" ")
            .filter((scope) =>
              (MCP_SCOPES as readonly string[]).includes(scope),
            ),
        });
      }),
    );
    app.post(
      "/connect/:uid/login",
      wrap(async (req, res) => {
        const { detail, state } = await interaction(req, res);
        csrf(req, state);
        const attempt = await identity.start(
          `${issuer.origin}/connect/callback/upstream`,
        );
        const proof = secret();
        await loginArtifact.upsert(
          attempt.state,
          { attempt, proof, uid: detail.uid },
          600,
        );
        // Distinct cookie per login allows independent concurrent browser connections.
        res.cookie(`nubis_login_${attempt.state}`, proof, {
          httpOnly: true,
          secure: issuer.protocol === "https:",
          sameSite: "lax",
          path: "/connect",
          maxAge: 600000,
        });
        res.json({
          redirectTo: identity.authorizationPage
            ? `${issuer.origin}/connect/login/upstream?state=${encodeURIComponent(attempt.state)}`
            : attempt.url,
        });
      }),
    );
    app.get(
      "/connect/login/upstream",
      wrap(async (req, res) => {
        const state =
          typeof req.query.state === "string" ? req.query.state : "";
        const login = (await loginArtifact.find(state)) as
          | {
              attempt: LoginAttempt;
              proof: string;
              uid: string;
              authorizationPage?: string;
              consumed?: number;
            }
          | undefined;
        const proof = cookies(req)[`nubis_login_${state}`];
        if (
          !identity.authorizationPage ||
          !login ||
          login.consumed ||
          typeof proof !== "string" ||
          !equal(proof, login.proof)
        )
          throw new Error("Invalid upstream sign-in entry");
        const page =
          login.authorizationPage ??
          (await identity.authorizationPage(login.attempt));
        if (!login.authorizationPage)
          await loginArtifact.upsert(
            state,
            { ...login, authorizationPage: page },
            600,
          );
        const destination = new URL(page);
        destination.searchParams.set("broker_state", state);
        res.redirect(303, destination.href);
      }),
    );
    app.get(
      "/connect/login/validate",
      wrap(async (req, res) => {
        const state = typeof req.query.state === "string" ? req.query.state : "";
        const id = typeof req.query.authorization_id === "string" ? req.query.authorization_id : "";
        const login = (await loginArtifact.find(state)) as
          | { proof: string; authorizationPage?: string; consumed?: number }
          | undefined;
        const proof = cookies(req)[`nubis_login_${state}`];
        if (!login || login.consumed || !login.authorizationPage ||
            typeof proof !== "string" || !equal(proof, login.proof) ||
            new URL(login.authorizationPage).searchParams.get("authorization_id") !== id) {
          throw new Error("Uncorrelated upstream authorization");
        }
        res.json({ valid: true });
      }),
    );
    app.get(
      "/connect/callback/upstream",
      wrap(async (req, res) => {
        const state =
          typeof req.query.state === "string" ? req.query.state : "";
        const login = (await loginArtifact.find(state)) as
          | { attempt: LoginAttempt; proof: string; uid: string }
          | undefined;
        const proof = cookies(req)[`nubis_login_${state}`];
        if (!login || typeof proof !== "string" || !equal(proof, login.proof))
          throw new Error("Invalid login callback");
        await loginArtifact.consume(state);
        const session = await identity.finish(
          new URL(req.originalUrl, issuer.origin),
          login.attempt,
        );
        const current = (await artifact.find(login.uid)) as
          | InteractionState
          | undefined;
        if (!current) throw new Error("Expired interaction");
        await artifact.upsert(
          login.uid,
          { ...current, upstream: session },
          600,
        );
        res.redirect(303, `${issuer.origin}/connect/${login.uid}`);
      }),
    );
    app.post(
      "/connect/:uid/decision",
      wrap(async (req, res) => {
        const { detail, state } = await interaction(req, res);
        csrf(req, state);
        if (req.body.decision === "deny") {
          const redirectTo = await provider.interactionResult(
            req,
            res,
            {
              error: "access_denied",
              error_description: "User denied workspace access",
            },
            { mergeWithLastSubmission: false },
          );
          res.json({ redirectTo });
          return;
        }
        if (req.body.decision !== "approve" || !state.upstream)
          throw new Error("Sign-in and approval required");
        const workspace = (await identity.workspaces(state.upstream)).find(
          (w) => w.id === req.body.workspaceId && w.actions.includes("read"),
        );
        if (!workspace) throw new Error("Workspace access denied");
        const requested = String(detail.params.scope ?? "").split(" ");
        if (!requested.includes(MCP_SCOPES[0]))
          throw new Error("Task read scope required");
        const scopes: string[] = [MCP_SCOPES[0]];
        if (
          req.body.allowWrite === true &&
          requested.includes(MCP_SCOPES[1]) &&
          workspace.actions.some((a) => a === "create" || a === "update")
        )
          scopes.push(MCP_SCOPES[1]);
        const clientId = String(detail.params.client_id);
        const grant = new provider.Grant({
          accountId: state.upstream.userId,
          clientId,
        });
        // Mirror the explicit decision in AS and resource scope bookkeeping.
        // Neither registration nor declaring a supported scope grants access.
        grant.addOIDCScope(
          requested
            .filter(
              (scope) =>
                scope === "openid" ||
                scope === "offline_access" ||
                scopes.includes(scope),
            )
            .join(" "),
        );
        const deniedScopes = requested.filter(
          (scope) =>
            (MCP_SCOPES as readonly string[]).includes(scope) &&
            !scopes.includes(scope),
        );
        grant.rejectOIDCScope(deniedScopes);
        grant.addResourceScope(resource.href, scopes.join(" "));
        grant.rejectResourceScope(resource.href, deniedScopes);
        const grantId = await grant.save();
        const client = await provider.Client.find(clientId);
        await store.saveConnection({
          grantId,
          interactionId: detail.uid,
          userId: state.upstream.userId,
          clientId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          clientName: client?.clientName ?? "MCP client",
          scopes,
          session: state.upstream,
          expiresAt: Date.now() / 1000 + ttl,
          revokedAt: null,
        });
        const redirectTo = await provider.interactionResult(
          req,
          res,
          { login: { accountId: state.upstream.userId }, consent: { grantId } },
          { mergeWithLastSubmission: false },
        );
        res.json({ redirectTo });
      }),
    );
    // The main app can manage its user's grants, but cannot drive broker consent.
    app.use("/connections", (req, res, next) => protectOrigins(req, res, next, [
      issuer.origin, options.appOrigin, ...(managementOrigin ? [managementOrigin.origin] : []),
    ]), express.json({ limit: "8kb" }));
    app.options(/^\/connections(?:\/.*)?$/, (_req, res) => {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.status(204).end();
    });
    const human = async (req: Request) => {
      const token = /^Bearer ([^\s]+)$/.exec(
        req.get("authorization") ?? "",
      )?.[1];
      if (!token) throw new Error("Sign-in required");
      return identity.userForToken(token);
    };
    app.get(
      "/connections",
      wrap(async (req, res) => {
        res.json({ data: await store.list(await human(req)) });
      }),
    );
    app.post(
      "/connections/:grantId/revoke",
      wrap(async (req, res) => {
        await store.revoke(String(req.params.grantId), await human(req));
        res.json({ data: { revoked: true } });
      }),
    );
    // The provider must see the raw request body. Mount before global body parsers/loggers.
    app.use(
      "/oauth",
      protect,
      rateLimit({
        windowMs: 60000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
      }),
      provider.callback(),
    );
    app.get(
      "/.well-known/oauth-authorization-server/oauth",
      protect,
      (req, res) => {
        // The RFC 8414 alias sits outside Express's /oauth mount. Preserve the
        // mount context or oidc-provider advertises unreachable root endpoints.
        req.url = "/.well-known/openid-configuration";
        req.baseUrl = issuer.pathname;
        req.originalUrl = `${issuer.pathname}${req.url}`;
        void provider.callback()(req, res);
      },
    );
  }
  const remote: RemoteMcpConfig = {
    resource: resource.href,
    issuer: issuer.href,
    scopesSupported: [...MCP_SCOPES],
    allowedOrigins: [options.appOrigin],
    async authorize(value) {
      const token = await provider.AccessToken.find(value);
      if (
        !token ||
        token.isExpired ||
        token.aud !== resource.href ||
        !token.grantId
      )
        throw new RemoteAuthError(401, "Invalid or expired MCP token");
      if (!(await provider.Grant.find(token.grantId)))
        throw new RemoteAuthError(403, "Connection revoked");
      const connection = await store.withSession(token.grantId, (session) =>
        identity.refresh(session),
      );
      if (
        !connection ||
        connection.userId !== token.accountId ||
        connection.clientId !== token.clientId
      )
        throw new RemoteAuthError(403, "Connection revoked");
      const access = identity.access
        ? await identity.access(connection.session, connection.workspaceId)
        : (await identity.workspaces(connection.session)).find(
            (w) => w.id === connection.workspaceId,
          );
      if (!access?.actions.includes("read"))
        throw new RemoteAuthError(403, "Workspace access unavailable");
      const scopes = MCP_SCOPES.filter(
        (scope) =>
          connection.scopes.includes(scope) &&
          token.scope?.split(" ").includes(scope),
      );
      if (!scopes.includes(MCP_SCOPES[0]))
        throw new RemoteAuthError(403, "Task read permission required");
      if (!access.actions.some((a) => a === "create" || a === "update"))
        scopes.splice(
          scopes.indexOf(MCP_SCOPES[1]),
          scopes.includes(MCP_SCOPES[1]) ? 1 : 0,
        );
      return {
        userId: connection.userId,
        workspaceId: connection.workspaceId,
        clientId: connection.clientId,
        grantId: connection.grantId,
        accessToken: connection.session.accessToken,
        expiresAt: token.exp!,
        scopes,
        actions: access.actions,
      };
    },
    async execute(principal, request) {
      const action =
        request.endpoint === "create_task"
          ? "create"
          : [
                "update_task",
                "move_task",
                "add_comment",
                "add_context_to_task",
              ].includes(request.endpoint)
            ? "update"
            : "read";
      if (!principal.actions?.includes(action))
        throw new Error(
          "Your current workspace role does not permit this action",
        );
      return options.execute(principal, request);
    },
  };
  return { provider, mount, remote };
}
