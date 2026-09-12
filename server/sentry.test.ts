import assert from "node:assert/strict";
import { scrubSentryEvent } from "./sentry.js";

{
  const scrubbed = scrubSentryEvent({
    request: {
      url: "https://mcp-server.nubis.app/get_tasks",
      data: { apiKey: "nubis_ag_secret", schema: { context: "secret notes" } },
      cookies: { session: "cookie-value" },
      headers: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.a.b",
        "x-api-key": "workspace-key",
        "content-type": "application/json",
      },
    },
    user: { email: "person@example.com", id: "uid-1" },
    extra: { apiKey: "plain-key", workspaceId: "ws-1" },
  });

  const request = scrubbed.request as Record<string, unknown>;
  assert.equal("data" in request, false, "request bodies must not be sent");
  assert.equal("cookies" in request, false);
  const headers = request.headers as Record<string, unknown>;
  assert.equal(headers.authorization, "[redacted]");
  assert.equal(headers["x-api-key"], "[redacted]");
  assert.equal(headers["content-type"], "application/json");
  assert.equal("user" in scrubbed, false, "user/PII must not be attached");
  const extra = scrubbed.extra as Record<string, unknown>;
  assert.equal(extra.apiKey, "[redacted]");
  assert.equal(extra.workspaceId, "ws-1");
}

console.log("server/sentry.test.ts: ok");
