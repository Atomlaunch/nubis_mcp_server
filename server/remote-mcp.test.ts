import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createRemoteAuthorizer,
  type WorkspaceGrant,
  type RemotePrincipal,
} from "./remote-auth.js";
import { registerRemoteMcp } from "./remote-mcp.js";
import { remoteMcpConfig } from "./remote-config.js";
import {
  createRemoteDispatcher,
  remoteRequestAuth,
} from "./remote-dispatch.js";
import { isOAuthToken } from "./request-auth.js";
import { buildTaskUpdatePatch } from "./task-patches.js";

const user = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const secondWorkspace = "33333333-3333-4333-8333-333333333333";
const grantId = "44444444-4444-4444-8444-444444444444";
const readScope = "nubis.tasks.read";
const writeScope = "nubis.tasks.write";
const now = Math.floor(Date.now() / 1000);
const keys = await generateKeyPair("ES256");
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "local-test-key",
  alg: "ES256",
  use: "sig",
};
let grant: WorkspaceGrant = {
  id: grantId,
  user_id: user,
  client_id: "test-client",
  workspace_id: workspace,
  scopes: [readScope, writeScope],
  revoked_at: null,
  expires_at: new Date((now + 3600) * 1000).toISOString(),
};
const secondGrant: WorkspaceGrant = {
  ...grant,
  id: "77777777-7777-4777-8777-777777777777",
  user_id: "88888888-8888-4888-8888-888888888888",
  workspace_id: secondWorkspace,
  client_id: "second-client",
};
let humanMember = true;
let unavailable = false;
let grantReads = 0;
const calls: Array<{ workspace: string; endpoint: string; schema: any }> = [];
const app = express();
app.use(express.json({ limit: "100kb" }));
app.get("/auth/v1/.well-known/jwks.json", (_req, res) =>
  res.json({ keys: [jwk] }),
);
const listener = app.listen(0, "127.0.0.1");
await once(listener, "listening");
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
const resource = `${base}/mcp`;
const issuer = `${base}/auth/v1`;
const authorize = createRemoteAuthorizer({
  issuer,
  resource,
  jwks: new URL(`${issuer}/.well-known/jwks.json`),
  async lookupGrant(_token, id) {
    grantReads++;
    if (unavailable) throw new Error("private DB error");
    return id === secondGrant.id ? secondGrant : grant;
  },
  async isHumanMember() {
    return humanMember;
  },
});
registerRemoteMcp(app, {
  resource,
  issuer,
  authorize,
  allowedOrigins: ["https://trusted-client.example"],
  async execute(principal, request) {
    calls.push({
      workspace: principal.workspaceId,
      endpoint: request.endpoint,
      schema: request.schema,
    });
    return {
      data:
        request.endpoint === "get_projects"
          ? [{ id: principal.workspaceId, name: "Selected workspace" }]
          : { id: "task", ...request.schema },
    };
  },
});
const clients: Client[] = [];
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: user,
    client_id: "test-client",
    role: "nubis_mcp",
    mcp_grant_id: grantId,
    mcp_workspace_id: workspace,
    scope: "openid",
    mcp_scopes: [readScope, writeScope],
    iss: issuer,
    aud: resource,
    iat: now,
    exp: now + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
    .sign(keys.privateKey);
}
async function connect(accessToken: string) {
  const client = new Client({ name: "nubis-local-acceptance", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}
async function status(
  accessToken?: string,
  headers: Record<string, string> = {},
) {
  return fetch(resource, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

try {
  assert.equal(
    remoteMcpConfig({}, async () => ({ data: null })),
    null,
    "remote endpoint stays disabled by default",
  );
  assert.throws(
    () =>
      remoteMcpConfig({ NUBIS_REMOTE_MCP_ENABLED: "true" }, async () => ({
        data: null,
      })),
    /requires/,
  );
  const metadata = await (
    await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
  ).json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.deepEqual(metadata.scopes_supported, ["openid"]);
  const unsigned = await status();
  assert.equal(unsigned.status, 401);
  assert.equal(
    unsigned.headers.get("www-authenticate"),
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
  );
  const valid = await token();
  assert.equal(isOAuthToken(valid), true);
  const legacy = await token({
    client_id: undefined,
    mcp_grant_id: undefined,
    mcp_workspace_id: undefined,
    role: "authenticated",
    aud: "authenticated",
  });
  assert.equal(isOAuthToken(legacy), false);
  assert.equal(
    (await status(legacy)).status,
    401,
    "regular user JWT is not an MCP token",
  );
  await Promise.all(
    [
      { aud: "another-resource" },
      { aud: [resource, "authenticated"] },
      { iat: now + 600 },
      { iss: "https://wrong-issuer.example" },
      { exp: now - 5 },
      { role: "authenticated" },
      { mcp_grant_id: undefined },
      { mcp_scopes: undefined },
      { client_id: "different-client" },
      { mcp_workspace_id: secondWorkspace },
      { sub: "55555555-5555-4555-8555-555555555555" },
    ].map(async (bad) => {
      const response = await status(await token(bad));
      assert.ok(
        [401, 403].includes(response.status),
        `must reject ${JSON.stringify(bad)}`,
      );
    }),
  );
  const readsBeforeForgery = grantReads;
  const segments = valid.split(".");
  segments[1] = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(segments[1], "base64url").toString()),
      mcp_workspace_id: secondWorkspace,
    }),
  ).toString("base64url");
  assert.equal((await status(segments.join("."))).status, 401);
  assert.equal(
    grantReads,
    readsBeforeForgery,
    "signature checked before grant access",
  );
  assert.equal(
    (await status(valid, { Origin: "https://attacker.example" })).status,
    403,
  );
  assert.equal((await status(valid, { Origin: "null" })).status, 403);
  const hostileHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = httpRequest(
        resource,
        {
          method: "POST",
          headers: {
            Host: "attacker.example",
            Authorization: `Bearer ${valid}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    },
  );
  assert.equal(hostileHostStatus, 403);
  const preflight = await fetch(resource, {
    method: "OPTIONS",
    headers: { Origin: "https://trusted-client.example" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://trusted-client.example",
  );

  const client = await connect(valid);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("get_task_boards") && names.includes("update_task"));
  for (const forbidden of [
    "delete_task",
    "delete_tasks",
    "mint_agent",
    "list_agent_memberships",
    "remove_blocker",
  ])
    assert.ok(!names.includes(forbidden));
  const result = await client.callTool({
    name: "get_projects",
    arguments: { workspaceId: secondWorkspace },
  });
  assert.ok(!result.isError);
  assert.equal(
    calls.at(-1)?.workspace,
    workspace,
    "tool arguments cannot choose another workspace",
  );
  assert.equal(
    calls.at(-1)?.schema.workspaceId,
    undefined,
    "unknown tool arguments stripped by schema",
  );
  const exactColumn = "66666666-6666-4666-8666-666666666666";
  const created = await client.callTool({
    name: "create_task",
    arguments: { title: "Exact placement", board_column_id: exactColumn },
  });
  assert.ok(!created.isError);
  assert.equal(calls.at(-1)?.schema.board_column_id, exactColumn);
  assert.equal(
    calls.at(-1)?.schema.board,
    undefined,
    "no default legacy status injected over custom column",
  );
  const before = calls.length;
  assert.equal(
    (await client.callTool({ name: "mint_agent", arguments: {} })).isError,
    true,
  );
  assert.equal(calls.length, before);
  assert.equal(
    (
      await fetch(resource, {
        method: "GET",
        headers: { Authorization: `Bearer ${valid}` },
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await fetch(resource, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${valid}` },
      })
    ).status,
    405,
  );

  const secondClient = await connect(
    await token({
      sub: secondGrant.user_id,
      client_id: secondGrant.client_id,
      mcp_grant_id: secondGrant.id,
      mcp_workspace_id: secondWorkspace,
    }),
  );
  const [firstResult, secondResult] = await Promise.all([
    client.callTool({ name: "get_projects", arguments: {} }),
    secondClient.callTool({ name: "get_projects", arguments: {} }),
  ]);
  assert.ok(JSON.stringify(firstResult.content).includes(workspace));
  assert.ok(!JSON.stringify(firstResult.content).includes(secondWorkspace));
  assert.ok(JSON.stringify(secondResult.content).includes(secondWorkspace));
  assert.ok(!JSON.stringify(secondResult.content).includes(workspace));

  const reader = await connect(await token({ mcp_scopes: [readScope] }));
  assert.ok(
    !(await reader.listTools()).tools.some(
      (tool) => tool.name === "create_task",
    ),
  );
  assert.equal(
    (
      await reader.callTool({
        name: "create_task",
        arguments: { title: "Denied" },
      })
    ).isError,
    true,
  );
  grant = { ...grant, scopes: [readScope] };
  assert.ok(
    !(await client.listTools()).tools.some(
      (tool) => tool.name === "update_task",
    ),
    "scope reduction observed on existing connection",
  );
  grant = { ...grant, revoked_at: new Date().toISOString() };
  assert.equal(
    (await status(valid)).status,
    403,
    "revocation immediately rejects already issued tokens",
  );
  grant = { ...grant, revoked_at: null };
  humanMember = false;
  assert.equal(
    (await status(valid)).status,
    403,
    "removed members cannot keep a connection",
  );
  humanMember = true;
  unavailable = true;
  const unavailableResponse = await status(valid);
  assert.equal(unavailableResponse.status, 503);
  assert.ok(!(await unavailableResponse.text()).includes("private DB error"));
  unavailable = false;

  // Exercise the in-process bridge independently: no HTTP-supplied auth context.
  const sentinelDb = {} as any;
  const dispatcher = createRemoteDispatcher(() => sentinelDb);
  dispatcher.register(express(), "/get_projects", async (req, res) => {
    const auth = remoteRequestAuth(req);
    assert.equal(auth?.authKind, "human_oauth");
    assert.equal(auth?.workspaceId, workspace);
    assert.equal(auth?.db, sentinelDb);
    res.json({ data: [auth?.workspaceId] });
  });
  const principal: RemotePrincipal = await authorize(valid);
  assert.deepEqual(
    await dispatcher.execute(principal, {
      endpoint: "get_projects",
      schema: {},
    }),
    { data: [workspace], api_usage: undefined },
  );
  dispatcher.register(express(), "/update_task", async (req, res) => {
    res.json({ data: buildTaskUpdatePatch(remoteRequestAuth(req)?.schema) });
  });
  assert.deepEqual(
    await dispatcher.execute(
      { ...principal, scopes: [readScope, writeScope] },
      {
        endpoint: "update_task",
        schema: {
          title: "Rename only",
          bolt_id: undefined,
          github_file_path: undefined,
          parent_task_id: null,
        },
      },
    ),
    {
      data: { title: "Rename only", parent_task_id: null },
      api_usage: undefined,
    },
    "in-process calls omit undefined fields like HTTP JSON, but retain explicit clears",
  );
  assert.equal(
    remoteRequestAuth({ body: { authKind: "human_oauth" } } as any),
    undefined,
  );
  await assert.rejects(
    dispatcher.execute(principal, {
      endpoint: "get_projects",
      schema: { workspaceId: secondWorkspace },
    }),
    /identity/,
  );
  await assert.rejects(
    dispatcher.execute(principal, { endpoint: "mint_agent", schema: {} }),
    /not permitted/,
  );
  console.log(
    "Remote MCP HTTP, signature, grant isolation, scopes, revocation, and dispatch tests passed",
  );
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}
