import assert from "node:assert/strict";
import type { Request } from "express";
import {
  agentKeyApiKeysLookupError,
  apiKeyFromRequest,
  authKindFromSecret,
  credentialsFromRequest,
  isAgentJwt,
  isAgentKey,
  isOwnerEquivalentRole,
  redactSecrets,
  taskIDFromBody,
  taskIDsFromBody,
  workspaceIdFromRequest,
} from "./request-auth.js";

const TASK_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

function fakeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return { body, headers } as Request;
}

function assertOldHandlerWould400(body: unknown) {
  const { schema } = credentialsFromRequest(fakeReq(body));
  const missing = typeof schema?.taskID !== "string" || !schema.taskID.trim();
  assert.equal(missing, true, "pre-fix handler only read schema.taskID");
}

// Reproduce the live 400: auth fields + taskID at the top level.
{
  const body = {
    workspaceId: "ws-1",
    apiKey: "key-1",
    taskID: TASK_ID,
  };
  assertOldHandlerWould400(body);
  assert.equal(taskIDFromBody(body), TASK_ID);
  const creds = credentialsFromRequest(fakeReq(body));
  assert.equal(creds.workspaceId, "ws-1");
  assert.equal(creds.apiKey, "key-1");
}

// Bearer equivalent of the same flat body.
{
  const body = { workspaceId: "ws-1", taskID: TASK_ID };
  const req = fakeReq(body, { authorization: "Bearer key-from-header" });
  assert.equal(workspaceIdFromRequest(body), "ws-1");
  assert.equal(apiKeyFromRequest(req, body), "key-from-header");
  assert.equal(taskIDFromBody(body), TASK_ID);
  assert.equal(credentialsFromRequest(req).schema, undefined);
}

// X-Api-Key fallback is unchanged.
{
  const body = { workspaceId: "ws-1", taskID: TASK_ID };
  const req = fakeReq(body, { "x-api-key": "key-from-x" });
  assert.equal(apiKeyFromRequest(req, body), "key-from-x");
  assert.equal(taskIDFromBody(body), TASK_ID);
}

// Body apiKey still wins over Bearer (PR 2 precedence).
{
  const body = { workspaceId: "ws-1", apiKey: "body-key", taskID: TASK_ID };
  const req = fakeReq(body, { authorization: "Bearer header-key" });
  assert.equal(apiKeyFromRequest(req, body), "body-key");
}

// MCP wrap still works: { workspaceId, apiKey, schema: { taskID } }.
{
  const body = {
    workspaceId: "ws-1",
    apiKey: "key-1",
    schema: { taskID: TASK_ID },
  };
  assert.equal(taskIDFromBody(body), TASK_ID);
  assert.equal(credentialsFromRequest(fakeReq(body)).schema.taskID, TASK_ID);
}

// Top-level taskID wins when schema is present but empty (HTTP body carries schema + taskID).
{
  const body = {
    workspaceId: "ws-1",
    apiKey: "key-1",
    schema: {},
    taskID: TASK_ID,
  };
  assertOldHandlerWould400(body);
  assert.equal(taskIDFromBody(body), TASK_ID);
}

// Empty / whitespace top-level taskID does not shadow schema.taskID.
{
  const body = {
    workspaceId: "ws-1",
    apiKey: "key-1",
    taskID: "   ",
    schema: { taskID: TASK_ID },
  };
  assert.equal(taskIDFromBody(body), TASK_ID);
}

// Field-name mismatch was not the live bug: MCP and the ticket both use taskID.
{
  assert.equal(taskIDFromBody({ taskId: TASK_ID } as any), "");
  assert.equal(taskIDFromBody({ id: TASK_ID } as any), "");
  assert.equal(taskIDFromBody({ workspaceId: "ws-1", apiKey: "key-1" }), "");
}

// delete_tasks: flat taskIDs and schema.taskIDs.
{
  assert.deepEqual(taskIDsFromBody({ taskIDs: [TASK_ID, OTHER_ID] }), [
    TASK_ID,
    OTHER_ID,
  ]);
  assert.deepEqual(
    taskIDsFromBody({ schema: { taskIDs: [TASK_ID] }, workspaceId: "ws-1" }),
    [TASK_ID]
  );
  assert.equal(taskIDsFromBody({ workspaceId: "ws-1", apiKey: "key-1" }), undefined);
  assert.equal(taskIDsFromBody({ schema: { taskID: TASK_ID } }), undefined);
  assert.deepEqual(taskIDsFromBody({ taskIDs: [] }), []);
}

const AGENT_KEY = "nubis_ag_test-secret-do-not-log";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudC11c2VyIn0.sig";

assert.equal(isAgentKey(AGENT_KEY), true);
assert.equal(isAgentKey("nubis_live_workspace"), false);
assert.equal(isAgentJwt(JWT), true);
assert.equal(isAgentJwt(AGENT_KEY), false);
assert.equal(authKindFromSecret(AGENT_KEY), "agent_key");
assert.equal(authKindFromSecret(JWT), "agent_jwt");
assert.equal(authKindFromSecret("plain-workspace-key"), "workspace_api_key");

{
  const err = agentKeyApiKeysLookupError(AGENT_KEY);
  assert.ok(err);
  assert.match(err, /nubis_ag_/);
  assert.match(err, /api_keys/);
  assert.equal(agentKeyApiKeysLookupError("workspace-key"), null);
}

{
  const req = fakeReq(
    { workspaceId: "ws-1", apiKey: AGENT_KEY, schema: { board: "inbox" } }
  );
  const creds = credentialsFromRequest(req);
  assert.equal(creds.authKind, "agent_key");
  assert.equal(creds.apiKey, AGENT_KEY);
}

{
  const req = fakeReq({ workspaceId: "ws-1" }, { authorization: `Bearer ${JWT}` });
  const creds = credentialsFromRequest(req);
  assert.equal(creds.authKind, "agent_jwt");
  assert.equal(isAgentKey(creds.apiKey), false);
}

{
  const req = fakeReq(
    { workspaceId: "ws-1", apiKey: "workspace-key" },
    { authorization: `Bearer ${AGENT_KEY}` }
  );
  const creds = credentialsFromRequest(req);
  assert.equal(creds.authKind, "workspace_api_key", "body workspace key still wins");
}

assert.equal(isOwnerEquivalentRole("owner"), true);
assert.equal(isOwnerEquivalentRole("admin"), true);
assert.equal(isOwnerEquivalentRole("co-owner"), false);
assert.equal(isOwnerEquivalentRole("member"), false);

{
  const redacted = redactSecrets({
    workspaceId: "ws-1",
    apiKey: AGENT_KEY,
    schema: { message: "hello", nestedKey: AGENT_KEY },
  }) as Record<string, unknown>;
  assert.equal(redacted.workspaceId, "ws-1");
  assert.equal(redacted.apiKey, "[redacted]");
  const schema = redacted.schema as Record<string, unknown>;
  assert.equal(schema.message, "hello");
  assert.equal(schema.nestedKey, "[redacted]");
  assert.equal(JSON.stringify(redacted).includes("nubis_ag_"), false);
}

{
  const redacted = redactSecrets({
    access_token: JWT,
    Authorization: `Bearer ${JWT}`,
  }) as Record<string, unknown>;
  assert.equal(redacted.access_token, "[redacted]");
  assert.equal(redacted.Authorization, "[redacted]");
}

console.log("request-auth tests passed");
