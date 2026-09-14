import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import express from "express";
import { Pool } from "pg";
import { exportJWK, generateKeyPair } from "jose";
import { chromium, type BrowserContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BrokerStore } from "./broker-store.js";
import { createOAuthBroker } from "./oauth-broker.js";
import { registerRemoteMcp } from "./remote-mcp.js";
import type { BrokerIdentity } from "./broker-identity.js";

const databaseUrl = process.env.NUBIS_BROKER_TEST_DATABASE_URL;
if (
  !databaseUrl ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)
)
  throw new Error(
    "Set NUBIS_BROKER_TEST_DATABASE_URL to an isolated localhost database",
  );
const pool = new Pool({ connectionString: databaseUrl });
const vaultKey = randomBytes(32);
const store = new BrokerStore(pool, vaultKey);
const userId = "11111111-1111-4111-8111-111111111111";
const workspaces = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Workspace A",
    actions: ["read", "create", "update"],
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Workspace B",
    actions: ["read"],
  },
];
let memberships = [...workspaces];
let refreshes = 0;
const app = express();
const listener = app.listen(0, "127.0.0.1");
await once(listener, "listening");
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
const resource = `${base}/mcp`;
let ui: ChildProcess | undefined;
let appOrigin = base;
if (process.env.NUBIS_PMTOOL_TEST_ROOT) {
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  appOrigin = `http://127.0.0.1:${port}`;
  const root = process.env.NUBIS_PMTOOL_TEST_ROOT;
  ui = spawn(
    process.execPath,
    [
      `${root}/node_modules/vite/bin/vite.js`,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        VITE_SUPABASE_URL: base,
        VITE_SUPABASE_ANON_KEY: "fixture-public-key",
        VITE_NUBIS_MCP_BROKER_URL: base,
        VITE_NUBIS_OAUTH_BROKER_CLIENT_ID: "fixture-client",
      },
    },
  );
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(appOrigin)).ok;
    } catch {}
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error("Local consent UI did not start");
}
const identity: BrokerIdentity = {
  async start(callback) {
    const state = randomBytes(16).toString("hex");
    return {
      state,
      verifier: "upstream-test-verifier",
      nonce: "upstream-test-nonce",
      url: `${base}/auth/v1/oauth/authorize?state=${state}&callback=${encodeURIComponent(callback)}`,
    };
  },
  async authorizationPage(attempt) {
    return attempt.url;
  },
  async finish(url, attempt) {
    assert.equal(url.searchParams.get("state"), attempt.state);
    return {
      userId,
      accessToken: "upstream-private-access",
      refreshToken: "upstream-private-refresh",
      expiresAt: Date.now() / 1000 + 3600,
    };
  },
  async refresh(session) {
    refreshes++;
    return { ...session, expiresAt: Date.now() / 1000 + 3600 };
  },
  async workspaces() {
    return memberships;
  },
  async userForToken(token) {
    if (token !== "browser-private-access")
      throw new Error("Invalid human session");
    return userId;
  },
};
app.get("/auth/v1/oauth/authorize", (req, res) =>
  res.redirect(
    `${req.query.callback}?state=${req.query.state}&code=fixture-only`,
  ),
);
const keys = await generateKeyPair("RS256");
const broker = await createOAuthBroker({
  issuer: `${base}/oauth`,
  resource,
  store,
  identity,
  appOrigin,
  managementOrigin: "https://app.example.test",
  cookieKeys: [randomBytes(32).toString("hex")],
  jwks: {
    keys: [
      {
        ...(await exportJWK(keys.privateKey)),
        kid: "test-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  },
  async execute(principal, request) {
    assert.equal(principal.accessToken, "upstream-private-access");
    return { data: [{ id: principal.workspaceId, name: "Bound workspace" }] };
  },
});
broker.mount(app);
const managementPreflight = await fetch(`${base}/connections`, {
  method: "OPTIONS", headers: { Origin: "https://app.example.test" },
});
assert.equal(managementPreflight.status, 204);
assert.equal(managementPreflight.headers.get("access-control-allow-origin"), "https://app.example.test");
assert.equal((await fetch(`${base}/connections`, {
  headers: { Origin: "https://app.example.test" },
})).status, 400, "management origin still requires a human token");
assert.equal((await fetch(`${base}/connections`, {
  method: "OPTIONS", headers: { Origin: "https://evil.example.test" },
})).status, 403);
assert.equal((await fetch(`${base}/connect/fixture`, {
  headers: { Origin: "https://app.example.test" },
})).status, 403, "management origin cannot drive consent");
app.use(express.json());
registerRemoteMcp(app, broker.remote);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.NUBIS_TEST_CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const clients: Client[] = [];
const discovery = await (
  await fetch(`${base}/.well-known/oauth-authorization-server/oauth`)
).json();
async function registerClient() {
  const response = await fetch(discovery.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Local MCP acceptance",
      scope: "nubis.tasks.read nubis.tasks.write",
      redirect_uris: [`${base}/client/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function begin(clientId: string, ctx: BrowserContext = context) {
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(16).toString("hex");
  const url = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: `${base}/client/callback`,
    response_type: "code",
    scope: "nubis.tasks.read nubis.tasks.write",
    resource,
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }))
    url.searchParams.set(key, value);
  const start = await ctx.request.get(url.href, { maxRedirects: 0 });
  assert.equal(start.status(), 303, await start.text());
  const interaction = start.headers().location;
  let details = await (await ctx.request.get(interaction)).json();
  const login = await ctx.request.post(`${interaction}/login`, {
    data: { csrf: details.csrf },
  });
  assert.equal(login.status(), 200, await login.text());
  const redirectTo = (await login.json()).redirectTo;
  assert.equal(
    (await fetch(redirectTo)).status,
    400,
    "upstream entry requires its browser proof cookie",
  );
  const signed = await ctx.request.get(redirectTo);
  assert.equal(signed.status(), 200, await signed.text());
  details = await signed.json();
  return { interaction, details, verifier, state, ctx, clientId };
}
async function decide(
  flow: Awaited<ReturnType<typeof begin>>,
  workspaceId: string,
  decision = "approve",
) {
  const result = await flow.ctx.request.post(`${flow.interaction}/decision`, {
    data: { csrf: flow.details.csrf, decision, workspaceId, allowWrite: true },
  });
  assert.equal(result.status(), 200, await result.text());
  const resumed = await flow.ctx.request.get((await result.json()).redirectTo, {
    maxRedirects: 0,
  });
  assert.equal(resumed.status(), 303, await resumed.text());
  const redirect = new URL(resumed.headers().location);
  assert.equal(redirect.searchParams.get("state"), flow.state);
  return redirect;
}
async function exchange(
  flow: Awaited<ReturnType<typeof begin>>,
  code: string,
  verifier = flow.verifier,
) {
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: `${base}/client/callback`,
      resource,
    }),
  });
  return { status: response.status, data: await response.json() };
}
async function refresh(clientId: string, token: string) {
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: token,
      resource,
    }),
  });
  return { status: response.status, data: await response.json() };
}
async function connect(token: string) {
  const client = new Client({ name: "broker-e2e", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
try {
  assert.equal(
    (
      await (
        await fetch(`${base}/.well-known/oauth-authorization-server/oauth`)
      ).json()
    ).issuer,
    `${base}/oauth`,
  );
  const registration = await registerClient();
  const correlationUrl = new URL(discovery.authorization_endpoint);
  correlationUrl.search = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: `${base}/client/callback`,
    response_type: "code", scope: "nubis.tasks.read", resource,
    code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const started = await context.request.get(correlationUrl.href, { maxRedirects: 0 });
  const correlationInteraction = started.headers().location;
  const correlationDetails = await (await context.request.get(correlationInteraction)).json();
  identity.authorizationPage = async () => `${base}/oauth/consent?authorization_id=correlated-authorization-fixture`;
  const correlationLogin = await context.request.post(`${correlationInteraction}/login`, { data: { csrf: correlationDetails.csrf } });
  const correlationEntry = (await correlationLogin.json()).redirectTo;
  const correlationPage = await context.request.get(correlationEntry, { maxRedirects: 0 });
  assert.equal(correlationPage.status(), 303);
  const correlationDestination = new URL(correlationPage.headers().location);
  const brokerState = correlationDestination.searchParams.get("broker_state")!;
  assert.ok(brokerState);
  const validationUrl = `${base}/connect/login/validate?state=${encodeURIComponent(brokerState)}&authorization_id=correlated-authorization-fixture`;
  assert.equal((await context.request.get(validationUrl)).status(), 200);
  assert.equal((await fetch(validationUrl)).status, 400, "correlation requires the originating browser cookie");
  assert.equal((await context.request.get(validationUrl.replace("correlated-authorization-fixture", "foreign-authorization-fixture"))).status(), 400);
  assert.equal((await context.request.get(validationUrl, { headers: { Origin: "https://evil.example.test" } })).status(), 403);
  identity.authorizationPage = undefined;
  const permanentClient = await pool.query(
    "select expires_at = 'infinity'::timestamptz as permanent from nubis_broker.artifacts where kind='Client' and id=$1",
    [registration.client_id],
  );
  assert.equal(
    permanentClient.rows[0].permanent,
    true,
    "client registration must not expire before its grants",
  );
  assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(discovery.response_types_supported, ["code"]);
  if (ui) {
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      [base, appOrigin].includes(new URL(route.request().url()).origin)
        ? route.continue()
        : route.abort(),
    );
    const verifier = randomBytes(32).toString("base64url"),
      state = randomBytes(16).toString("hex");
    const authorization = new URL(discovery.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: registration.client_id,
      redirect_uri: `${base}/client/callback`,
      response_type: "code",
      scope: "nubis.tasks.read nubis.tasks.write",
      resource,
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }))
      authorization.searchParams.set(key, value);
    await page.goto(authorization.href);
    await page
      .getByRole("button", { name: "Continue to Nubis sign-in" })
      .click();
    await page
      .getByLabel("Workspace", { exact: true })
      .selectOption(workspaces[0].id);
    await page
      .getByRole("checkbox", { name: "Also allow creating and updating tasks" })
      .check();
    await page.screenshot({
      path: "/tmp/nubis-oauth-consent-proof.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Approve connection" }).click();
    await page.waitForURL((url) => url.pathname === "/client/callback");
    const callback = new URL(page.url());
    assert.equal(callback.searchParams.get("state"), state);
    const tokens = await exchange(
      { verifier, state, clientId: registration.client_id } as Awaited<
        ReturnType<typeof begin>
      >,
      callback.searchParams.get("code")!,
    );
    assert.equal(tokens.status, 200, tokens.data.error_description);
    assert.equal(
      (await broker.remote.authorize(tokens.data.access_token)).workspaceId,
      workspaces[0].id,
    );
    await page.close();
    console.log(
      "Rendered Nubis consent: sign-in, workspace choice, approval, and code exchange passed",
    );
  }
  // Two consent transactions for the SAME user/client, exchanged in reverse order.
  const [a, b] = await Promise.all([
    begin(registration.client_id),
    begin(registration.client_id),
  ]);
  assert.equal(a.details.workspaces.length, 2);
  const foreign = await a.ctx.request.post(`${a.interaction}/decision`, {
    data: {
      csrf: a.details.csrf,
      decision: "approve",
      workspaceId: "44444444-4444-4444-8444-444444444444",
    },
  });
  assert.equal(foreign.status(), 400);
  const csrf = await b.ctx.request.post(`${b.interaction}/decision`, {
    data: { csrf: "wrong", decision: "approve", workspaceId: workspaces[1].id },
  });
  assert.equal(csrf.status(), 400);
  const [aRedirect, bRedirect] = await Promise.all([
    decide(a, workspaces[0].id),
    decide(b, workspaces[1].id),
  ]);
  const bTokens = await exchange(b, bRedirect.searchParams.get("code")!);
  assert.equal(bTokens.status, 200, bTokens.data.error_description);
  const aTokens = await exchange(a, aRedirect.searchParams.get("code")!);
  assert.equal(aTokens.status, 200, aTokens.data.error_description);
  assert.notEqual(aTokens.data.access_token, "upstream-private-access");
  assert.ok(!JSON.stringify(aTokens.data).includes("upstream-private"));
  const [aClient, bClient] = await Promise.all([
    connect(aTokens.data.access_token),
    connect(bTokens.data.access_token),
  ]);
  const [aResult, bResult] = await Promise.all([
    aClient.callTool({ name: "get_projects", arguments: {} }),
    bClient.callTool({ name: "get_projects", arguments: {} }),
  ]);
  assert.ok(JSON.stringify(aResult).includes(workspaces[0].id));
  assert.ok(!JSON.stringify(aResult).includes(workspaces[1].id));
  assert.ok(JSON.stringify(bResult).includes(workspaces[1].id));
  assert.ok(
    !(await bClient.listTools()).tools.some(
      (tool) => tool.name === "create_task",
    ),
  );
  const replayFlow = await begin(registration.client_id);
  const replayRedirect = await decide(replayFlow, workspaces[0].id);
  const firstExchange = await exchange(
    replayFlow,
    replayRedirect.searchParams.get("code")!,
  );
  assert.equal(firstExchange.status, 200);
  assert.equal(
    (await exchange(replayFlow, replayRedirect.searchParams.get("code")!))
      .status,
    400,
    "code replay rejected",
  );
  await assert.rejects(
    broker.remote.authorize(firstExchange.data.access_token),
    "code replay revokes its own token family",
  );
  const renewed = await refresh(
    registration.client_id,
    aTokens.data.refresh_token,
  );
  assert.equal(renewed.status, 200, renewed.data.error_description);
  assert.equal(
    (await broker.remote.authorize(renewed.data.access_token)).workspaceId,
    workspaces[0].id,
  );
  const refreshReplay = await begin(registration.client_id);
  const refreshRedirect = await decide(refreshReplay, workspaces[0].id);
  const refreshOriginal = await exchange(
    refreshReplay,
    refreshRedirect.searchParams.get("code")!,
  );
  const refreshRotated = await refresh(
    registration.client_id,
    refreshOriginal.data.refresh_token,
  );
  assert.equal(refreshRotated.status, 200);
  assert.notEqual(
    refreshRotated.data.refresh_token,
    refreshOriginal.data.refresh_token,
  );
  assert.equal(
    (await refresh(registration.client_id, refreshOriginal.data.refresh_token))
      .status,
    400,
    "rotated refresh token cannot be replayed",
  );
  await assert.rejects(
    broker.remote.authorize(refreshRotated.data.access_token),
    "refresh replay revokes that family",
  );
  assert.equal(
    (await broker.remote.authorize(renewed.data.access_token)).workspaceId,
    workspaces[0].id,
    "refresh replay cannot revoke another family",
  );
  const denied = await begin(registration.client_id);
  const denial = await decide(denied, workspaces[0].id, "deny");
  assert.equal(denial.searchParams.get("error"), "access_denied");
  assert.equal(denial.searchParams.get("code"), null);
  const badPkce = await begin(registration.client_id);
  const badRedirect = await decide(badPkce, workspaces[0].id);
  assert.equal(
    (
      await exchange(
        badPkce,
        badRedirect.searchParams.get("code")!,
        randomBytes(32).toString("base64url"),
      )
    ).status,
    400,
  );
  const grantId = (await broker.remote.authorize(renewed.data.access_token))
    .grantId;
  const list = await (
    await fetch(`${base}/connections`, {
      headers: { Authorization: "Bearer browser-private-access" },
    })
  ).json();
  assert.ok(list.data.some((row: any) => row.grant_id === grantId));
  assert.ok(!JSON.stringify(list).includes("upstream-private"));
  const raw = await pool.query(
    "select upstream_session from nubis_broker.connections where grant_id=$1",
    [grantId],
  );
  assert.ok(!raw.rows[0].upstream_session.includes("upstream-private"));
  const revoke = await fetch(`${base}/connections/${grantId}/revoke`, {
    method: "POST",
    headers: { Authorization: "Bearer browser-private-access" },
  });
  assert.equal(revoke.status, 200);
  await assert.rejects(broker.remote.authorize(renewed.data.access_token));
  assert.equal(
    (await refresh(registration.client_id, renewed.data.refresh_token)).status,
    400,
    "revoked connection cannot refresh",
  );
  assert.equal(
    (await broker.remote.authorize(bTokens.data.access_token)).workspaceId,
    workspaces[1].id,
    "revocation must not affect the other connection",
  );
  memberships = [];
  await assert.rejects(broker.remote.authorize(bTokens.data.access_token));
  assert.equal(refreshes, 0);
  await assert.rejects(
    pool.query(
      "update nubis_broker.connections set workspace_id=$2 where grant_id=$1",
      [grantId, workspaces[1].id],
    ),
    /immutable/,
  );
  const fixtureId = randomBytes(16).toString("hex");
  const fixture = {
    grantId: fixtureId,
    interactionId: fixtureId,
    userId,
    clientId: registration.client_id,
    workspaceId: workspaces[0].id,
    clientName: "Refresh fixture",
    workspaceName: "Workspace A",
    scopes: ["nubis.tasks.read"],
    session: {
      userId,
      accessToken: "fixture-old",
      refreshToken: "fixture-private-refresh",
      expiresAt: Date.now() / 1000 - 1,
    },
    expiresAt: Date.now() / 1000 + 3600,
    revokedAt: null,
  };
  await store.saveConnection(fixture);
  let rotated = 0;
  const rotate = async (session: typeof fixture.session) => {
    rotated++;
    await sleep(25);
    return {
      ...session,
      accessToken: "fixture-new",
      expiresAt: Date.now() / 1000 + 3600,
    };
  };
  const sessions = await Promise.all([
    store.withSession(fixtureId, rotate),
    store.withSession(fixtureId, rotate),
  ]);
  assert.equal(rotated, 1, "upstream refresh is serialized");
  assert.ok(
    sessions.every((item) => item?.session.accessToken === "fixture-new"),
  );
  assert.equal(
    (await new BrokerStore(pool, vaultKey).connection(fixtureId))?.session
      .accessToken,
    "fixture-new",
    "vault survives a new store instance",
  );
  await pool.query(
    "update nubis_broker.connections set refresh_pending=true where grant_id=$1",
    [fixtureId],
  );
  assert.equal(
    await store.withSession(fixtureId, rotate),
    null,
    "interrupted upstream refresh fails closed",
  );
  assert.equal(rotated, 1, "uncertain refresh is not retried");
  const onceOnly = store.adapter("FixtureCode");
  await onceOnly.upsert(fixtureId, { uid: fixtureId }, 60);
  const attempts = await Promise.allSettled([
    onceOnly.consume(fixtureId),
    onceOnly.consume(fixtureId),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
    "concurrent code consumption is atomic",
  );
  console.log(
    "Broker PostgreSQL + browser cookies + OAuth PKCE/refresh/consent/revocation + real MCP client test passed",
  );
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await browser.close();
  if (ui && ui.exitCode === null) {
    ui.kill("SIGTERM");
    await once(ui, "exit");
  }
  listener.closeAllConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await pool.end();
}
