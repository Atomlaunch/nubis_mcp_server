import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

async function smoke(remoteOnly: boolean) {
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
        PORT: String(port),
        HOST: "127.0.0.1",
        SUPABASE_URL: "http://127.0.0.1:9",
        ...(remoteOnly
          ? { SUPABASE_ANON_KEY: "fixture-anon", NUBIS_REMOTE_MCP_ONLY: "true" }
          : { SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-key" }),
        NUBIS_REMOTE_MCP_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Middleware exited before health check: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        healthy = response.ok && (await response.json()).status === "ok";
      } catch {}
      if (healthy) break;
      await sleep(100);
    }
    assert.ok(healthy, output);
    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
      ),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [404, 404],
    );
    if (remoteOnly) {
      const blocked = await Promise.all(
        [
          "/get_tasks",
          "/get_projects",
          "/mint_agent",
          "/delete_tasks",
          "/oauth-untrusted",
        ].map((path) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        ),
      );
      assert.ok(
        blocked.every((r) => r.status === 404),
        "dedicated broker must not expose legacy handlers",
      );
      assert.equal(
        (
          await fetch(
            `http://127.0.0.1:${port}/connect/unknown?code=fixture-sensitive-code`,
          )
        ).status,
        404,
      );
      assert.ok(
        !output.includes("fixture-sensitive-code"),
        "unknown broker routes must not reach legacy request logging",
      );
    }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
}
await Promise.all([smoke(false), smoke(true)]);
console.log(
  "Built legacy and anon-only broker startup, disabled defaults, and legacy-route isolation smoke tests passed",
);
