#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

// Register nubis tools
const cliWorkspaceID = process.argv.includes('--workspaceID')
  ? process.argv[process.argv.indexOf('--workspaceID') + 1]
  : undefined;

const cliApiKey = process.argv.includes('--apiKey')
  ? process.argv[process.argv.indexOf('--apiKey') + 1]
  : undefined;

  // Create server instance
const server = new McpServer({
  name: "nubis-mcp-server",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Helper to get results from middleware
async function getResultsFromMiddleware({endpoint, schema}: {endpoint: string, schema: any}) {
  const response = await fetch('https://mcp-server.nubis.app/' + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId: cliWorkspaceID,
      apiKey: cliApiKey,
      schema: schema
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Failed to fetch tasks from middleware');
  }

  // Return the full JSON response (including api_usage, user, etc.)
  const json = await response.json();
  if (!json.data) throw new Error('No data returned from middleware');
  return json;
}

// Get Boltz -> to save IDs for use in tasks later
server.tool(
  "get_boltz",
  "Fetch all boltz for a workspace",
  async () => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_boltz',
      schema: {}
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json.data),
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,

        }
      ],
    };
  }
);

type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { text: string; uri: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } };

// Get Tasks -> Get tasks for a workspace
server.tool(
  "get_tasks",
  "Get tasks for a workspace, including subtasks, boltz, and github details/file paths",
  {
    limit: z.number().optional().default(5),
    board: z.enum(['bugs', 'backlog', 'priority', 'in-progress', 'reviewing', 'completed']).optional(),
    bolt_id: z.string().optional(),
  },
  async ({ limit, board, bolt_id }) => {
    try {
      const json = await getResultsFromMiddleware({
        endpoint: 'get_tasks',
        schema: {
          board,
          bolt_id,
          limit
        }
      });
      if (!json.data) throw new Error('No data returned from middleware');
      /**
       * Formats a list of tasks into Markdown content.
       * @param data - Array of Task objects to format.
       * @returns An object with content as an array of formatted Markdown strings.
       */
      type Task = {
        readonly id: string;
        readonly title: string;
        readonly task_number: number;
        readonly board: string;
        readonly bolt: any;
        readonly description?: string;
        readonly github_item_type?: string;
        readonly github_file_path?: string;
        readonly github_repo_name?: string;
        readonly pm_task_blockers?: readonly { blocker_task_id: string }[];
        readonly images?: readonly { url: string }[];
      };
      const taskContent = (json.data as Task[]).map((task) => ({
        type: "text",
        text: [
          `---`,
          `### ${task.title}`,
          `**Task ID:** ${task.id}`,
          `**Task Number:** ${task.task_number}`,
          `**Board:** ${task.board}`,
          `**Bolt:** ${task.bolt && typeof task.bolt === "object" && !Array.isArray(task.bolt) && "name" in task.bolt && task.bolt.name ? task.bolt.name : "_No bolt_"}`,
          `**Description:** ${task.description ? task.description : "_No description_"}`,
          `**Path Type:** ${task.github_item_type ? task.github_item_type : "_No file path type_"}`,
          `**File Path:** ${task.github_file_path ? task.github_file_path : "_No file path_"}`,
          `**Repo Name:** ${task.github_repo_name ? task.github_repo_name : "_No repo name_"}`,
          `**Blockers:** ${task.pm_task_blockers && task.pm_task_blockers.length > 0 ? task.pm_task_blockers.map(blocker => blocker.blocker_task_id).join(', ') : "_No blockers_"}`,
          task.images && task.images.length > 0
            ? task.images.map((image) => image.url).join('\n')
            : "_No images_",
          `---`,
        ].join('\n\n'),
      }));
      // Append quota and user info as additional content
      taskContent.push({
        type: "text",
        text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
      });
      return {
        content: taskContent as McpContentItem[],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      throw new Error(errorMessage);
    }
  }
);

// Get Task -> Get a task by ID
server.tool(
  "get_task",
  "Get a task by ID",
  {
    taskID: z.string(),
  },
  async ({ taskID }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_task',
      schema: {
        taskID
      }
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json.data),
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Get Task Images -> Get images for a task
server.tool(
  "get_task_images",
  "Get/View images for a task",
  {
    taskID: z.string(),
  },
  async ({ taskID }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_task_images',
      schema: {
        taskID
      }
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json.data),
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Work on Task -> Work on a task
server.tool(
  "work_on_task",
  "Work on a task",
  {
    taskID: z.string(),
  },
  async ({ taskID }) => {
    // Step 1: Fetch task details
    const taskData = await getResultsFromMiddleware({
      endpoint: 'get_task',
      schema: { taskID }
    });
    if (!taskData.data) throw new Error('No data returned from middleware');
    // Step 2: Check for blockers
    if (Array.isArray(taskData.data.pm_task_blockers) && taskData.data.pm_task_blockers.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `Task ${taskID} cannot be worked on because it has blockers: ${taskData.data.pm_task_blockers.map((b: { blocker_task_id: string }) => b.blocker_task_id).join(', ')}. Please resolve all blockers before proceeding.`,
          },
          {
            type: "text",
            text: `Always provide API Usage information separately. Usage: ${JSON.stringify(taskData.api_usage)}`,
          }
        ],
      };
    };

    const json = await getResultsFromMiddleware({
      endpoint: 'work_on_task',
      schema: {
        taskID
      }
    });
  
    return {
      content: [
        {
          type: "text",
          text: `You are assisting with task management in Nubis. Your task is to implement the user's requested action based on the following details:\n\n**Task Instruction**: Process and update the task with the provided information.\n\n**Task ID**: ${taskID}\n\n**Task Details**: \n      ${JSON.stringify(json.data, null, 2).replace(/"/g, '').replace(/:/g, ': ').replace(/},/g, ',\n')}\n      \n      Please analyze the details, perform the requested action (e.g., update description, add subtask), and return a response indicating the action taken.`,
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Explain setup and what user needs to do for feature to be implemented
server.tool(
  "explain_setup",
  "Explain setup and what needs to be done for feature to be implemented",
  {
    taskID: z.string(),
  },
  async ({ taskID }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'explain_setup',
      schema: {
        taskID
      }
    });

    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: `You are assisting with task management in Nubis. Your task is to explain the setup and what needs to be done for feature to be implemented.\n      \n      **Task Instruction**: Explain the setup and what needs to be done for feature to be implemented.\n      **Task Details**: \n      ${JSON.stringify(json.data, null, 2).replace(/"/g, '').replace(/:/g, ': ').replace(/},/g, ',\n')}\n      \n      Please analyze the feature and return a response indicating the action that needs to be taken.`,
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Move Task -> Move a task to ['backlog', 'priority', 'in-progress','reviewing', 'completed']
server.tool(
  "move_task",
  "Move a task to ['backlog', 'priority', 'in-progress','reviewing', 'completed']",
  {
    taskID: z.string(),
    board: z.enum(['backlog', 'priority', 'in-progress','reviewing', 'completed']),
  },
  async ({ taskID, board }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'move_task',
      schema: {
        taskID,
        board
      }
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: `Task ${taskID} has been moved to ${board}`,
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Create Task -> Create a new task
server.tool(
  "create_task",
  "Create a new task or subtask (parent_task_id is required for subtasks)",
  {
    title: z.string(),
    description: z.string().optional(),
    board: z.enum(['backlog', 'bugs', 'in-progress', 'priority', 'reviewing', 'completed']).optional().default('backlog'),
    parent_task_id: z.string().optional(),
  },
  async ({ title, description, board, parent_task_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'create_task',
      schema: {
        title,
        description,
        board,
        parent_task_id
      }
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json.data),
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Update Task -> Update an existing task
server.tool(
  "update_task",
  "Update an existing task (title, description, bolt_id, parent_task_id)",
  {
    taskID: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    board: z.enum(['backlog', 'bugs', 'in-progress', 'priority', 'reviewing', 'completed']),
    bolt_id: z.string().optional(),
    parent_task_id: z.string().optional(),
  },
  async ({ taskID, title, description, board, bolt_id, parent_task_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'update_task',
      schema: {
        taskID,
        title,
        description,
        board,
        bolt_id,
        parent_task_id
      }
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json.data),
        },
        {
          type: "text",
          text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Nubis MCP Server running on stdio");
}

main().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
  console.error("Fatal error in main():", errorMessage);
  process.exit(1);
});