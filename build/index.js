#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Register nubis tools
const cliWorkspaceID = process.argv.includes('--workspaceID')
    ? process.argv[process.argv.indexOf('--workspaceID') + 1]
    : undefined;
const cliApiKey = process.argv.includes('--apiKey')
    ? process.argv[process.argv.indexOf('--apiKey') + 1]
    : undefined;
// Create server instance
const server = new mcp_js_1.McpServer({
    name: "nubis-mcp-server",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    },
});
// Helper to get results from middleware
async function getResultsFromMiddleware({ endpoint, schema }) {
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
    const { data } = await response.json();
    if (!data)
        throw new Error('No data returned from middleware');
    return data;
}
// Get Tasks -> Get tasks for a workspace
server.tool("get_tasks", "Get tasks for a workspace", {
    limit: zod_1.z.number().optional().default(5),
    board: zod_1.z.enum(['bugs', 'backlog', 'priority', 'in-progress', 'reviewing', 'completed']).optional(),
}, async ({ limit, board }) => {
    try {
        const data = await getResultsFromMiddleware({
            endpoint: 'get_tasks',
            schema: {
                board,
                limit
            }
        });
        if (!data)
            throw new Error('No data returned from middleware');
        return {
            content: data.map((task) => ({
                type: "text",
                text: [
                    `==============`,
                    `### ${task.title}`,
                    `**Task ID:** ${task.id}`,
                    `**Task Number:** ${task.task_number}`,
                    `**Board:** ${task.board}`,
                    `**Description:** ${task.description ? task.description : "_No description_"}`,
                    task.images && task.images.length > 0
                        ? task.images.map((image) => image.url).join('\n')
                        : "_No images_",
                    `==============`,
                ].join('\n\n'),
            })),
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        throw new Error(errorMessage);
    }
});
// Get Task -> Get a task by ID
server.tool("get_task", "Get a task by ID", {
    taskID: zod_1.z.string(),
}, async ({ taskID }) => {
    const data = await getResultsFromMiddleware({
        endpoint: 'get_task',
        schema: {
            taskID
        }
    });
    if (!data)
        throw new Error('No data returned from middleware');
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(data),
            },
        ],
    };
});
// Get Task Images -> Get images for a task
server.tool("get_task_images", "Get/View images for a task", {
    taskID: zod_1.z.string(),
}, async ({ taskID }) => {
    const data = await getResultsFromMiddleware({
        endpoint: 'get_task_images',
        schema: {
            taskID
        }
    });
    if (!data)
        throw new Error('No data returned from middleware');
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(data),
            },
        ],
    };
});
// Work on Task -> Work on a task
server.tool("work_on_task", "Work on a task", {
    taskID: zod_1.z.string(),
}, async ({ taskID }) => {
    const data = await getResultsFromMiddleware({
        endpoint: 'work_on_task',
        schema: {
            taskID
        }
    });
    if (!data)
        throw new Error('No data returned from middleware');
    return {
        content: [
            {
                type: "text",
                text: `You are assisting with task management in Nubis. Your task is to implement the user's requested action based on the following details:
      \n      **Task Instruction**: Process and update the task with the provided information.\n      **Task ID**: ${taskID}\n      **Task Details**: \n      ${JSON.stringify(data, null, 2).replace(/"/g, '').replace(/:/g, ': ').replace(/},/g, ',\n')}\n      \n      Please analyze the details, perform the requested action (e.g., update description, add subtask), and return a response indicating the action taken.`
            },
        ],
    };
});
// Explain setup and what user needs to do for feature to be implemented
server.tool("explain_setup", "Explain setup and what needs to be done for feature to be implemented", {
    taskID: zod_1.z.string(),
}, async ({ taskID }) => {
    const data = await getResultsFromMiddleware({
        endpoint: 'explain_setup',
        schema: {
            taskID
        }
    });
    if (!data)
        throw new Error('No data returned from middleware');
    return {
        content: [
            {
                type: "text",
                text: `You are assisting with task management in Nubis. Your task is to explain the setup and what needs to be done for feature to be implemented.\n      \n      **Task Instruction**: Explain the setup and what needs to be done for feature to be implemented.\n      **Task Details**: \n      ${JSON.stringify(data, null, 2).replace(/"/g, '').replace(/:/g, ': ').replace(/},/g, ',\n')}\n      \n      Please analyze the feature and return a response indicating the action that needs to be taken.`
            },
        ],
    };
});
// Move Task -> Move a task to ['backlog', 'in-progress','reviewing', 'completed']
server.tool("move_task", "Move a task to ['backlog', 'in-progress','reviewing', 'completed']", {
    taskID: zod_1.z.string(),
    board: zod_1.z.enum(['backlog', 'in-progress', 'reviewing', 'completed']),
}, async ({ taskID, board }) => {
    const data = await getResultsFromMiddleware({
        endpoint: 'move_task',
        schema: {
            taskID,
            board
        }
    });
    if (!data)
        throw new Error('No data returned from middleware');
    return {
        content: [
            {
                type: "text",
                text: `Task ${taskID} has been moved to ${board}`,
            },
        ],
    };
});
// Start server
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("Nubis MCP Server running on stdio");
}
main().catch((error) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error("Fatal error in main():", errorMessage);
    process.exit(1);
});
