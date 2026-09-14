import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import { Pool } from "pg";
import { SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerRemoteMcp } from "./remote-mcp.js";
import { RemoteAuthError, type RemotePrincipal } from "./remote-auth.js";

const database = process.env.NUBIS_WRITE_TEST_DATABASE_URL;
const rest = process.env.NUBIS_WRITE_TEST_POSTGREST_URL;
assert.ok(
  database && rest,
  "Provide isolated write-test database and PostgREST URLs",
);
assert.equal(new URL(database).hostname, "127.0.0.1");
assert.equal(new URL(database).pathname, "/nubis_mcp_write_acceptance");
assert.equal(new URL(rest).hostname, "127.0.0.1");
const pool = new Pool({ connectionString: database });
const id = () => randomUUID();
const user = id(),
  stranger = id(),
  a = id(),
  b = id(),
  pa = id(),
  pb = id(),
  ba = id(),
  bb = id(),
  active = id(),
  done = id(),
  foreignColumn = id(),
  foreignTask = id();
await pool.query("insert into pm_projects(id,name) values($1,$2),($3,$4)", [
  a,
  "Write fixture A",
  b,
  "Write fixture B",
]);
await pool.query(
  "insert into pm_members(project_id,user_id) values($1,$3),($2,$3),($2,$4)",
  [a, b, user, stranger],
);
await pool.query(
  "insert into pm_branches(id,project_id,name) values($1,$2,$3),($4,$5,$6)",
  [pa, a, "Project A", pb, b, "Project B"],
);
await pool.query(
  "insert into pm_task_boards(id,project_id,name) values($1,$2,$3),($4,$5,$6)",
  [ba, pa, "Board A", bb, pb, "Board B"],
);
await pool.query(
  "insert into pm_task_board_columns(id,board_id,name,position,behavior,legacy_status_key) values($1,$2,'Review',0,'active','in-progress'),($3,$2,'Shipped',1,'done','in-progress'),($4,$5,'Foreign',0,'active','inbox')",
  [active, ba, done, foreignColumn, bb],
);
await pool.query(
  "insert into pm_tasks(id,project_id,branch_id,board_id,board_column_id,title,created_by) values($1,$2,$3,$4,$5,'Foreign task',$6)",
  [foreignTask, b, pb, bb, foreignColumn, user],
);
const key = new TextEncoder().encode(
  "local-write-fixture-jwt-secret-at-least-32-characters",
);
const jwt = async (role: string, sub?: string) =>
  new SignJWT({ role, ...(sub ? { sub } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
const [userJwt, serviceJwt, anonJwt] = await Promise.all([
  jwt("authenticated", user),
  jwt("service_role"),
  jwt("anon"),
]);
let userWrites = 0,
  privilegedWrites = 0;
let numberBarrier: Array<() => void> | undefined;
let numberConflicts = 0;
let contextBarrier: Array<() => void> | undefined;
let moveBarrier: Array<() => void> | undefined;
const proxy = http
  .createServer((req, res) => {
    if (!req.url?.startsWith("/rest/v1/")) {
      res.writeHead(404).end();
      return;
    }
    if (["POST", "PATCH", "DELETE"].includes(req.method!)) {
      if (req.headers.authorization === `Bearer ${userJwt}`) userWrites++;
      else privilegedWrites++;
    }
    const target = new URL(req.url.slice("/rest/v1".length), rest);
    if (req.method === "PATCH" && target.pathname === "/pm_tasks") {
      assert.equal(
        target.searchParams.has("context"),
        false,
        "private context must never be placed in URL filters",
      );
    }
    const upstream = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (response) => {
        if (req.method === "POST" && response.statusCode === 409)
          numberConflicts++;
        if (
          moveBarrier &&
          req.method === "GET" &&
          target.pathname === "/pm_tasks" &&
          target.searchParams.get("select") === "*"
        ) {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            moveBarrier!.push(() => {
              res.writeHead(response.statusCode!, response.headers);
              res.end(Buffer.concat(chunks));
            });
            if (moveBarrier!.length === 2) {
              const release = moveBarrier!;
              moveBarrier = undefined;
              release.forEach((send) => send());
            }
          });
          return;
        }
        if (
          contextBarrier &&
          req.method === "GET" &&
          target.searchParams.get("select") === "id,context,xmin"
        ) {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            contextBarrier!.push(() => {
              res.writeHead(response.statusCode!, response.headers);
              res.end(Buffer.concat(chunks));
            });
            if (contextBarrier!.length === 4) {
              const release = contextBarrier!;
              contextBarrier = undefined;
              release.forEach((send) => send());
            }
          });
          return;
        }
        if (
          numberBarrier &&
          req.method === "GET" &&
          target.searchParams.get("select") === "task_number"
        ) {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            numberBarrier!.push(() => {
              res.writeHead(response.statusCode!, response.headers);
              res.end(Buffer.concat(chunks));
            });
            if (numberBarrier!.length === 4) {
              const release = numberBarrier!;
              numberBarrier = undefined;
              release.forEach((send) => send());
            }
          });
          return;
        }
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  })
  .listen(0, "127.0.0.1");
await once(proxy, "listening");
const dbOrigin = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
const reservation = http.createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
Object.assign(process.env, {
  SUPABASE_URL: dbOrigin,
  SUPABASE_SERVICE_ROLE_KEY: serviceJwt,
  SUPABASE_ANON_KEY: anonJwt,
  PORT: String(port),
  HOST: "127.0.0.1",
  NUBIS_REMOTE_MCP_ENABLED: "false",
});
const { remoteDispatcher, httpServer } = await import("./index.js");
const app = express();
app.use(express.json());
const listener = app.listen(0, "127.0.0.1");
await once(listener, "listening");
const origin = `http://127.0.0.1:${(listener.address() as import("node:net").AddressInfo).port}`;
// Authentication is a fixture here. OAuth issuance/refresh is covered separately.
// This suite exercises the real MCP transport, registry, middleware handlers and PostgREST/RLS.
const principal: RemotePrincipal = {
  userId: user,
  clientId: "write-fixture",
  workspaceId: a,
  grantId: id(),
  accessToken: userJwt,
  expiresAt: Date.now() / 1000 + 3600,
  scopes: ["nubis.tasks.read", "nubis.tasks.write"],
  actions: ["read", "create", "update"],
};
registerRemoteMcp(app, {
  resource: `${origin}/mcp`,
  issuer: `${origin}/oauth`,
  authorize: async (token) => {
    if (token === "write-fixture") return principal;
    if (token === "read-fixture")
      return { ...principal, scopes: ["nubis.tasks.read"] };
    throw new RemoteAuthError(401, "Invalid fixture credential");
  },
  execute: remoteDispatcher.execute,
});
const client = new Client({ name: "real-write-pipeline-test", version: "1" }),
  reader = new Client({ name: "read-only-pipeline-test", version: "1" });
const task = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse((result.content as any[])[0].text);
};
const denied = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} must be rejected`);
};
try {
  await Promise.all(
    [
      [client, "write-fixture"],
      [reader, "read-fixture"],
    ].map(async ([c, token]) =>
      (c as Client).connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      ),
    ),
  );
  const tools = (await reader.listTools()).tools.map((t) => t.name);
  assert.ok(!tools.includes("create_task"));
  assert.ok(
    !(await client.listTools()).tools.some((t) => t.name === "delete_task"),
  );
  assert.equal(
    (
      await reader.callTool({
        name: "create_task",
        arguments: {
          title: "Read-only connection must not write",
          project_id: pa,
        },
      })
    ).isError,
    true,
  );
  const created = await task("create_task", {
    title: "Created through real middleware",
    project_id: pa,
    board_column_id: active,
    assignee_id: user,
  });
  assert.equal(created.project_id, a);
  assert.equal(created.branch_id, pa);
  assert.equal(created.board_id, ba);
  assert.equal(created.board_column_id, active);
  assert.equal(created.board, "in-progress");
  assert.equal(created.created_by, user);
  assert.equal(created._assignee, user);
  const updated = await task("update_task", {
    taskID: created.id,
    title: "Updated through real middleware",
    description: "Acceptance proof",
    board_column_id: done,
  });
  assert.equal(updated.title, "Updated through real middleware");
  assert.equal(updated.board, "done");
  assert.equal(updated.board_column_id, done);
  const renamed = await task("update_task", {
    taskID: created.id,
    title: "Title-only keeps workflow",
  });
  assert.equal(renamed.board_column_id, done);
  assert.equal(renamed.board_id, ba);
  const subtask = await task("create_task", {
    title: "Valid child",
    project_id: pa,
    parent_task_id: created.id,
    github_item_type: "file",
    github_file_path: "src/example.ts",
    github_repo_name: "fixture/repo",
  });
  assert.equal(subtask.parent_task_id, created.id);
  const childRename = await task("update_task", {
    taskID: subtask.id,
    title: "Renamed child",
  });
  assert.equal(childRename.parent_task_id, created.id);
  assert.equal(childRename.branch_id, pa);
  assert.equal(childRename.github_file_path, "src/example.ts");
  assert.equal(childRename.github_repo_name, "fixture/repo");
  const unassigned = await task("update_task", {
    taskID: created.id,
    assignee_id: null,
  });
  assert.equal(unassigned._assignee, null);
  await task("move_task", { taskID: created.id, board_column_id: active });
  assert.equal(
    (
      await pool.query("select board_column_id from pm_tasks where id=$1", [
        created.id,
      ])
    ).rows[0].board_column_id,
    active,
  );
  const comment = await task("add_comment", {
    taskID: created.id,
    content: "Original comment",
  });
  assert.equal(comment.project_id, a);
  assert.equal(comment.user_id, user);
  const reply = await task("add_comment", {
    taskID: created.id,
    content: "Reply",
    parent_id: comment.id,
  });
  assert.equal(reply.parent_id, comment.id);
  const foreignComment = id();
  await pool.query(
    "insert into pm_comments(id,project_id,task_id,user_id,content) values($1,$2,$3,$4,'Foreign comment')",
    [foreignComment, b, foreignTask, user],
  );
  await denied("add_comment", {
    taskID: foreignTask,
    content: "Foreign task injection",
  });
  await denied("add_comment", {
    taskID: created.id,
    parent_id: foreignComment,
    content: "Foreign parent injection",
  });
  await denied("add_comment", {
    taskID: subtask.id,
    parent_id: comment.id,
    content: "Wrong parent task",
  });
  await task("add_context_to_task", {
    taskID: created.id,
    context: "Initial context",
  });
  const appended = await task("add_context_to_task", {
    taskID: created.id,
    context: "Additional context",
  });
  assert.equal(appended.context, "Initial context\n\nAdditional context");
  const contextTask = await task("create_task", {
    title: "Concurrent context",
    project_id: pa,
    board_column_id: active,
  });
  contextBarrier = [];
  const fragments = [
    "Writer alpha",
    "Writer beta",
    "Writer gamma",
    "Writer delta",
  ];
  await Promise.all(
    fragments.map((context) =>
      task("add_context_to_task", { taskID: contextTask.id, context }),
    ),
  );
  const combined = (
    await pool.query("select context from pm_tasks where id=$1", [
      contextTask.id,
    ])
  ).rows[0].context;
  assert.deepEqual(
    combined.split("\n\n").sort(),
    [...fragments].sort(),
    "simultaneous appends must retain every writer exactly once",
  );
  const largeContext = "Private fixture note ".repeat(1000);
  await task("add_context_to_task", {
    taskID: contextTask.id,
    context: largeContext,
  });
  const afterLarge = await task("add_context_to_task", {
    taskID: contextTask.id,
    context: "After large note",
  });
  assert.ok(afterLarge.context.endsWith(`${largeContext}\n\nAfter large note`));
  const moveTask = await task("create_task", {
    title: "Concurrent move",
    project_id: pa,
    board_column_id: active,
  });
  moveBarrier = [];
  await Promise.all([
    task("update_task", {
      taskID: moveTask.id,
      title: "Title preserved during move",
    }),
    task("move_task", { taskID: moveTask.id, board_column_id: done }),
  ]);
  let moved = (
    await pool.query("select * from pm_tasks where id=$1", [moveTask.id])
  ).rows[0];
  assert.equal(moved.title, "Title preserved during move");
  assert.equal(moved.board_column_id, done);
  await Promise.all(
    [active, done, active, done].map((board_column_id) =>
      task("move_task", { taskID: moveTask.id, board_column_id }),
    ),
  );
  moved = (
    await pool.query("select * from pm_tasks where id=$1", [moveTask.id])
  ).rows[0];
  assert.equal(moved.branch_id, pa);
  assert.equal(moved.board_id, ba);
  assert.ok([active, done].includes(moved.board_column_id));
  assert.equal(
    moved.board,
    moved.board_column_id === done ? "done" : "in-progress",
  );
  assert.equal(moved.title, "Title preserved during move");
  await denied("add_context_to_task", {
    taskID: foreignTask,
    context: "Foreign context injection",
  });
  for (const [name, args] of [
    ["add_comment", { taskID: created.id, content: "Denied" }],
    ["add_context_to_task", { taskID: created.id, context: "Denied" }],
  ] as const) {
    assert.equal(
      (await reader.callTool({ name, arguments: args })).isError,
      true,
    );
  }
  await denied("create_task", {
    title: "Forbidden foreign column",
    board_column_id: foreignColumn,
  });
  await denied("create_task", {
    title: "Forbidden foreign project",
    project_id: pb,
  });
  await denied("create_task", {
    title: "Forbidden foreign parent",
    parent_task_id: foreignTask,
  });
  await denied("create_task", {
    title: "Forbidden foreign assignee",
    project_id: pa,
    assignee_id: stranger,
  });
  await denied("update_task", {
    taskID: foreignTask,
    title: "Forbidden cross-workspace edit",
  });
  await denied("update_task", {
    taskID: created.id,
    project_id: pa,
    board_column_id: foreignColumn,
  });
  await assert.rejects(
    remoteDispatcher.execute(principal, {
      endpoint: "create_task",
      schema: { title: "Identity injection", workspaceId: b },
    }),
    /identity/,
  );
  // Even if routing were bypassed, use the actual application consistency trigger.
  await assert.rejects(
    pool.query(
      "update pm_tasks set board_id=$2,board_column_id=$3 where id=$1",
      [created.id, bb, foreignColumn],
    ),
    /must belong/,
  );
  // Force four clients to observe the same max number before any can insert.
  numberBarrier = [];
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      task("create_task", { title: `Concurrent task ${i}`, project_id: pa }),
    ),
  );
  assert.equal(new Set(concurrent.map((t) => t.task_number)).size, 4);
  assert.ok(
    numberConflicts > 0,
    "the unique-constraint race was actually exercised",
  );
  assert.equal(numberBarrier, undefined);
  const before = (
    await pool.query("select title from pm_tasks where id=$1", [created.id])
  ).rows[0].title;
  await pool.query(
    "update pm_members set can_update=false where project_id=$1 and user_id=$2",
    [a, user],
  );
  await denied("update_task", {
    taskID: created.id,
    title: "Must fail at RLS",
  });
  await denied("add_comment", {
    taskID: created.id,
    content: "Must fail comment RLS",
  });
  await denied("add_context_to_task", {
    taskID: created.id,
    context: "Must fail context RLS",
  });
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from pm_comments where project_id=$1",
        [a],
      )
    ).rows[0].count,
    2,
  );
  assert.equal(
    (await pool.query("select context from pm_tasks where id=$1", [created.id]))
      .rows[0].context,
    "Initial context\n\nAdditional context",
  );
  assert.equal(
    (await pool.query("select title from pm_tasks where id=$1", [created.id]))
      .rows[0].title,
    before,
  );
  await pool.query(
    "update pm_members set can_create=false where project_id=$1 and user_id=$2",
    [a, user],
  );
  await denied("create_task", {
    title: "Must fail create RLS",
    project_id: pa,
  });
  assert.deepEqual(
    (await pool.query("select id from pm_tasks where project_id=$1", [a])).rows
      .map((row) => row.id)
      .sort(),
    [
      created.id,
      subtask.id,
      contextTask.id,
      moveTask.id,
      ...concurrent.map((task) => task.id),
    ].sort(),
    "exactly the successful creates persisted; denied writes leave no partial tasks",
  );
  assert.equal(
    (await pool.query("select title from pm_tasks where id=$1", [foreignTask]))
      .rows[0].title,
    "Foreign task",
  );
  assert.ok(userWrites >= 5);
  assert.equal(
    privilegedWrites,
    0,
    "OAuth writes never use service-role or anonymous credentials",
  );
  console.log(
    "Real MCP → existing create/update handlers → PostgREST → PostgreSQL/RLS passed: creation, updates, exact columns, subtasks, assignment, cross-workspace rejection, role restrictions, no privileged writes.",
  );
} finally {
  await Promise.all([client.close(), reader.close()]);
  for (const server of [listener, httpServer, proxy]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool.end();
}
