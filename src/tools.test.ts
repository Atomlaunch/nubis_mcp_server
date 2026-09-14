import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createNubisMcpServer } from "./tools.js";

async function registryTest() {
  const calls: Array<{ endpoint: string; schema: any }> = [];
  const server = createNubisMcpServer(async (request) => {
    calls.push(request);
    if (request.endpoint === "get_tasks")
      return {
        data: [
          {
            id: "task",
            title: "Custom column",
            task_number: 42,
            board: "in-progress",
            branch_id: "project",
            board_id: "board",
            board_column_id: "column",
          },
        ],
      };
    return { data: { id: "task", ...request.schema } };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "registry-test", version: "1" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "get_boltz",
      "get_projects",
      "get_task_boards",
      "mint_agent",
      "delete_task",
      "delete_tasks",
      "create_task",
      "update_task",
      "move_task",
    ])
      assert.ok(names.includes(name), name);
    const column = "66666666-6666-4666-8666-666666666666";
    assert.ok(
      !(
        await client.callTool({
          name: "create_task",
          arguments: { title: "Exact", board_column_id: column },
        })
      ).isError,
    );
    assert.equal(calls.at(-1)?.schema.board_column_id, column);
    assert.equal(calls.at(-1)?.schema.board, undefined);
    await client.callTool({
      name: "update_task",
      arguments: { taskID: "task", assignee_id: null, project_id: null },
    });
    assert.equal(calls.at(-1)?.schema.assignee_id, null);
    assert.equal(calls.at(-1)?.schema.project_id, null);
    await client.callTool({
      name: "move_task",
      arguments: { taskID: "task", board: "backlog" },
    });
    assert.equal(
      calls.at(-1)?.schema.board,
      "backlog",
      "legacy schema remains accepted before HTTP canonicalization",
    );
    const tasks = await client.callTool({
      name: "get_tasks",
      arguments: { board_column_id: column },
    });
    assert.equal(calls.at(-1)?.schema.board_column_id, column);
    assert.match(JSON.stringify(tasks.content), /Workflow ID.*board/);
    assert.match(JSON.stringify(tasks.content), /Column ID.*column/);
    const count = calls.length;
    assert.equal(
      (
        await client.callTool({
          name: "create_task",
          arguments: { title: "Bad", board_column_id: "not-a-uuid" },
        })
      ).isError,
      true,
    );
    assert.equal(
      calls.length,
      count,
      "invalid destination rejected before HTTP",
    );
  } finally {
    await client.close();
    await server.close();
  }
}
async function stdioTest() {
  const client = new Client({ name: "stdio-compatibility", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../build/index.js", import.meta.url))],
    cwd: "/tmp",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      NUBIS_API_KEY: "local-test-not-a-key",
      NUBIS_WORKSPACE_ID: "22222222-2222-4222-8222-222222222222",
    },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_task_boards"));
    assert.ok(tools.tools.some((tool) => tool.name === "mint_agent"));
  } finally {
    await client.close();
  }
}
await Promise.all([registryTest(), stdioTest()]);
console.log("Shared registry payload tests and built stdio handshake passed");
