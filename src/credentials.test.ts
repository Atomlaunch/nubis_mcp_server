import assert from "node:assert/strict";
import { argvFlag, resolveClientCredentials } from "./credentials.js";

const TASK_ID = "11111111-1111-1111-1111-111111111111";

function middlewareBody(workspaceId: string | undefined, apiKey: string | undefined) {
  return JSON.stringify({
    workspaceId,
    apiKey,
    schema: { taskID: TASK_ID },
  });
}

// Reproduce the live 401/400: undefined workspaceId is dropped by JSON.stringify.
{
  const sent = JSON.parse(middlewareBody(undefined, undefined));
  assert.equal("workspaceId" in sent, false, "JSON.stringify drops undefined workspaceId");
  assert.equal("apiKey" in sent, false, "JSON.stringify drops undefined apiKey");
  assert.equal(sent.schema.taskID, TASK_ID);
}

// Empty env + argv must throw before a body is sent, and name the env vars.
{
  assert.throws(
    () => resolveClientCredentials({ env: {}, argv: ["node", "build/index.js"] }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /workspaceId is required/);
      assert.match(err.message, /NUBIS_WORKSPACE_ID/);
      assert.match(err.message, /NUBIS_WORKSPACEID/);
      assert.match(err.message, /WORKSPACE_ID/);
      return true;
    }
  );
}

{
  assert.throws(
    () =>
      resolveClientCredentials({
        env: { NUBIS_WORKSPACE_ID: "ws-1" },
        argv: ["node", "build/index.js"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /apiKey is required/);
      assert.match(err.message, /NUBIS_API_KEY/);
      assert.match(err.message, /NUBIS_ACCESS_TOKEN/);
      assert.match(err.message, /ACCESS_TOKEN/);
      return true;
    }
  );
}

// Canonical env names used in the README Cursor config.
{
  const creds = resolveClientCredentials({
    env: { NUBIS_WORKSPACE_ID: "ws-canonical", NUBIS_API_KEY: "key-canonical" },
    argv: [],
  });
  assert.equal(creds.workspaceId, "ws-canonical");
  assert.equal(creds.apiKey, "key-canonical");
  const sent = JSON.parse(middlewareBody(creds.workspaceId, creds.apiKey));
  assert.equal(sent.workspaceId, "ws-canonical");
  assert.equal(sent.apiKey, "key-canonical");
}

// Cursor/npx aliases: NUBIS_WORKSPACEID + NUBIS_ACCESS_TOKEN.
{
  const creds = resolveClientCredentials({
    env: { NUBIS_WORKSPACEID: "ws-alias", NUBIS_ACCESS_TOKEN: "token-alias" },
    argv: [],
  });
  assert.equal(creds.workspaceId, "ws-alias");
  assert.equal(creds.apiKey, "token-alias");
}

// Short aliases: WORKSPACE_ID + ACCESS_TOKEN.
{
  const creds = resolveClientCredentials({
    env: { WORKSPACE_ID: "ws-short", ACCESS_TOKEN: "token-short" },
    argv: [],
  });
  assert.equal(creds.workspaceId, "ws-short");
  assert.equal(creds.apiKey, "token-short");
}

// Blank / whitespace env values are treated as missing so aliases can fill in.
{
  const creds = resolveClientCredentials({
    env: {
      NUBIS_WORKSPACE_ID: "  ",
      NUBIS_WORKSPACEID: "ws-from-alias",
      NUBIS_API_KEY: "",
      ACCESS_TOKEN: " key-from-alias ",
    },
    argv: [],
  });
  assert.equal(creds.workspaceId, "ws-from-alias");
  assert.equal(creds.apiKey, "key-from-alias");
}

// README argv: --workspaceID and --access-token as separate args.
{
  const creds = resolveClientCredentials({
    env: {},
    argv: [
      "node",
      "build/index.js",
      "--workspaceID",
      "ws-argv",
      "--access-token",
      "key-argv",
    ],
  });
  assert.equal(creds.workspaceId, "ws-argv");
  assert.equal(creds.apiKey, "key-argv");
}

// Equals form also works.
{
  const creds = resolveClientCredentials({
    env: {},
    argv: [
      "node",
      "build/index.js",
      "--workspaceID=ws-eq",
      "--access-token=key-eq",
    ],
  });
  assert.equal(creds.workspaceId, "ws-eq");
  assert.equal(creds.apiKey, "key-eq");
}

// Argv wins over env (npx flags documented in README).
{
  const creds = resolveClientCredentials({
    env: { NUBIS_WORKSPACE_ID: "ws-env", NUBIS_API_KEY: "key-env" },
    argv: ["node", "build/index.js", "--workspaceID", "ws-flag", "--access-token", "key-flag"],
  });
  assert.equal(creds.workspaceId, "ws-flag");
  assert.equal(creds.apiKey, "key-flag");
}

// argvFlag ignores a following flag as the value.
{
  assert.equal(argvFlag("--workspaceID", ["--workspaceID", "--access-token"]), "");
  assert.equal(argvFlag("--access-token", ["--access-token"]), "");
}

// Request-time read: later env changes are visible (not a one-shot import snapshot).
{
  const env: NodeJS.ProcessEnv = {};
  assert.throws(() => resolveClientCredentials({ env, argv: [] }));
  env.NUBIS_WORKSPACE_ID = "ws-later";
  env.NUBIS_API_KEY = "key-later";
  const creds = resolveClientCredentials({ env, argv: [] });
  assert.equal(creds.workspaceId, "ws-later");
  assert.equal(creds.authKind, "workspace_api_key");
  if (creds.authKind === "workspace_api_key") {
    assert.equal(creds.apiKey, "key-later");
  }
}

// Agent key env: NUBIS_AGENT_KEY (nubis_ag_ prefix is the live token shape).
{
  const creds = resolveClientCredentials({
    env: {
      NUBIS_WORKSPACE_ID: "ws-agent",
      NUBIS_AGENT_KEY: "nubis_ag_live-secret",
    },
    argv: [],
  });
  assert.equal(creds.workspaceId, "ws-agent");
  assert.equal(creds.authKind, "agent_key");
  if (creds.authKind === "agent_key") {
    assert.equal(creds.agentKey, "nubis_ag_live-secret");
  }
}

// --agent-key argv; do not overload --access-token.
{
  const creds = resolveClientCredentials({
    env: { NUBIS_WORKSPACE_ID: "ws-agent-flag" },
    argv: ["node", "build/index.js", "--agent-key", "nubis_ag_from-flag"],
  });
  assert.equal(creds.authKind, "agent_key");
  if (creds.authKind === "agent_key") {
    assert.equal(creds.agentKey, "nubis_ag_from-flag");
  }
}

{
  const creds = resolveClientCredentials({
    env: {},
    argv: [
      "node",
      "build/index.js",
      "--workspaceID=ws-eq-agent",
      "--agent-key=nubis_ag_eq",
    ],
  });
  assert.equal(creds.workspaceId, "ws-eq-agent");
  assert.equal(creds.authKind, "agent_key");
}

// Hard-error if both workspace API key and agent key are set.
{
  assert.throws(
    () =>
      resolveClientCredentials({
        env: {
          NUBIS_WORKSPACE_ID: "ws-both",
          NUBIS_API_KEY: "human-key",
          NUBIS_AGENT_KEY: "nubis_ag_agent-key",
        },
        argv: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Cannot set both/);
      assert.match(err.message, /NUBIS_API_KEY/);
      assert.match(err.message, /NUBIS_AGENT_KEY/);
      return true;
    }
  );
}

{
  assert.throws(
    () =>
      resolveClientCredentials({
        env: { NUBIS_WORKSPACE_ID: "ws-both", NUBIS_API_KEY: "human-key" },
        argv: ["node", "build/index.js", "--agent-key", "nubis_ag_flag"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Cannot set both/);
      return true;
    }
  );
}

{
  assert.throws(
    () =>
      resolveClientCredentials({
        env: {
          NUBIS_WORKSPACE_ID: "ws-both",
          NUBIS_ACCESS_TOKEN: "token-alias",
          NUBIS_AGENT_KEY: "nubis_ag_agent-key",
        },
        argv: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Cannot set both/);
      return true;
    }
  );
}

// Agent mode still requires workspace UUID out of band.
{
  assert.throws(
    () =>
      resolveClientCredentials({
        env: { NUBIS_AGENT_KEY: "nubis_ag_orphan" },
        argv: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /workspaceId is required/);
      return true;
    }
  );
}

console.log("src/credentials.test.ts: ok");

