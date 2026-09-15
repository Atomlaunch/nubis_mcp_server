import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerConsentUi } from "./consent-ui.js";
const root = mkdtempSync(join(tmpdir(), "nubis-consent-static-"));
mkdirSync(join(root, "assets"));
writeFileSync(
  join(root, "index.html"),
  '<html><script>window.theme="light";</script><p>Consent fixture</p></html>',
);
writeFileSync(join(root, "assets", "app.js"), 'console.log("fixture")');
writeFileSync(join(root, "private.env"), "fixture-only");
writeFileSync(join(root, "assets", ".env"), "fixture-only");
const app = express();
registerConsentUi(app, root, "https://identity.fixture.test");
app.use("/oauth", (_req, res) => res.sendStatus(418));
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => res.sendStatus(error.status ?? 500),
);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  const paths = [
    "/",
    "/mcp/connect",
    "/oauth/consent",
    "/login",
    "/assets/app.js",
    "/oauth/token",
    "/get_tasks",
    "/private.env",
    "/assets/../private.env",
    "/assets/.env",
    "/workspace/fixture-workspace/mcp-setup",
    "/workspace/fixture-workspace/tasks",
  ];
  const responses = await Promise.all(paths.map((path) => fetch(base + path)));
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200, 200, 200, 200, 418, 404, 404, 404, 403, 200, 404],
  );
  const policy = responses[0].headers.get("content-security-policy")!;
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("'sha256-"));
  assert.ok(
    !policy.split("script-src")[1].split(";")[0].includes("unsafe-inline"),
  );
  assert.equal(responses[0].headers.get("referrer-policy"), "no-referrer");
  assert.equal(responses[0].headers.get("cache-control"), "no-store");
  console.log(
    "Same-origin consent hosting: route isolation, CSP hashes, private-file protection and provider endpoint preservation passed",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
