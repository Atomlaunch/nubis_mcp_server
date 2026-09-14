import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// Real built middleware and HTTP auth flow; Supabase/Edge are explicit contract
// doubles. Real database/RLS acceptance is covered by separate integration tests.
const workspace = "00000000-0000-4000-8000-000000000001";
const uid = "00000000-0000-4000-8000-000000000002";
const project = "00000000-0000-4000-8000-000000000003";
const key = "fixture-workspace-key",
  agentKey = "nubis_ag_fixture-contract-only";
const service = "fixture-service",
  anon = "fixture-anon";
const jwt = (claims: object) =>
  `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
const agentJwt = jwt({ sub: uid, role: "authenticated" });
let revoked = false;
let keyRevoked = false;
let gateUnavailable = false;
const hits: { path: string; authorization: string }[] = [];
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://fixture");
  const authorization = req.headers.authorization ?? "";
  hits.push({ path: url.pathname, authorization });
  res.setHeader("Content-Type", "application/json");
  const send = (data: unknown, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  if (url.pathname === "/rest/v1/rpc/agent_jwt_allowed") {
    assert.equal(authorization, `Bearer ${agentJwt}`);
    if (gateUnavailable)
      return send({ message: "Fixture gate unavailable" }, 500);
    return send(!keyRevoked);
  }
  if (url.pathname === "/auth/v1/user") {
    if (authorization !== `Bearer ${agentJwt}` || revoked)
      return send({ message: "Invalid session" }, 401);
    return send({ id: uid });
  }
  if (url.pathname === "/functions/v1/agent-token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (
      JSON.parse(body).api_key !== agentKey ||
      authorization !== `Bearer ${anon}`
    )
      return send({ message: "Invalid agent key" }, 401);
    return send({
      access_token: agentJwt,
      expires_in: 3600,
      user: { id: uid },
    });
  }
  if (
    authorization !== `Bearer ${service}` &&
    authorization !== `Bearer ${agentJwt}`
  )
    return send({ message: "Wrong credential" }, 401);
  let rows: object[] = [];
  if (url.pathname === "/rest/v1/api_keys") {
    assert.equal(authorization, `Bearer ${service}`);
    rows =
      url.searchParams.get("api_key") === `eq.${key}` ? [{ user_id: uid }] : [];
  } else if (url.pathname === "/rest/v1/pm_members") {
    rows =
      url.searchParams.get("project_id") === `eq.${workspace}`
        ? [{ id: uid, role: "owner", member_kind: "agent" }]
        : [];
  } else if (url.pathname === "/rest/v1/workspace_subscriptions") {
    rows = [
      {
        status: "active",
        subscription_plans: { name: "Fixture", price_monthly: 1, features: {} },
      },
    ];
  } else if (url.pathname === "/rest/v1/pm_branches") {
    assert.equal(url.searchParams.get("project_id"), `eq.${workspace}`);
    rows = [{ id: project, project_id: workspace, name: "Fixture project" }];
  } else
    return send({ message: `Unexpected contract route: ${url.pathname}` }, 500);
  if (req.headers.accept?.includes("application/vnd.pgrst.object+json"))
    return rows.length === 1
      ? send(rows[0])
      : send({ code: "PGRST116", message: "Expected one row" }, 406);
  send(rows);
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as AddressInfo).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./dist/server/index.js", import.meta.url))],
  {
    cwd: "/tmp",
    env: {
      PATH: process.env.PATH ?? "",
      HOST: "127.0.0.1",
      PORT: String(port),
      SUPABASE_URL: upstreamUrl,
      SUPABASE_SERVICE_ROLE_KEY: service,
      SUPABASE_ANON_KEY: anon,
      NUBIS_REMOTE_MCP_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const call = (
  secret: string,
  path = "/get_projects",
  workspaceId = workspace,
) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, apiKey: secret, schema: {} }),
  });
try {
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw Error(output);
    try {
      healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {}
    if (healthy) break;
    await sleep(100);
  }
  assert.ok(healthy, output);
  await Promise.all(
    ["/get_boltz", "/get_projects"].map(async (path) => {
      const response = await call(key, path);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data[0].id, project);
      assert.ok(body.api_usage, "legacy usage information retained");
    }),
  );
  assert.equal((await call("wrong-fixture-key")).status, 401);
  assert.equal(
    (await call(key, "/get_projects", "00000000-0000-4000-8000-000000000099"))
      .status,
    401,
  );
  await Promise.all(
    [agentKey, agentJwt].map(async (secret) => {
      const start = hits.length;
      const response = await call(secret);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data[0].id, project);
      assert.ok(
        hits
          .slice(start)
          .every(
            (hit) =>
              hit.path !== "/rest/v1/api_keys" &&
              hit.authorization !== `Bearer ${service}`,
          ),
        "agent flow never falls back to workspace keys or privileged DB credentials",
      );
    }),
  );
  const before = hits.length;
  assert.equal(
    (await call(jwt({ sub: uid, client_id: "fixture-oauth-client" }))).status,
    403,
  );
  assert.equal(
    hits.length,
    before,
    "OAuth JWT rejected on legacy routes before any upstream access",
  );
  keyRevoked = true;
  assert.equal(
    (await call(agentJwt)).status,
    403,
    "a still-valid Auth JWT must stop reading after agent-key revocation",
  );
  keyRevoked = false;
  gateUnavailable = true;
  assert.equal((await call(agentJwt)).status, 403, "gate errors fail closed");
  gateUnavailable = false;
  revoked = true;
  assert.equal((await call(agentJwt)).status, 401);
  assert.ok(
    ![key, agentKey, agentJwt].some((secret) => output.includes(secret)),
    "request logs redact credentials",
  );
  console.log(
    "Built legacy HTTP contracts passed: workspace keys, aliases, usage, agent-key exchange, agent JWT, invalid/revoked sessions, workspace denial, OAuth rejection and no agent service-role fallback. Upstream is a contract double.",
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}
