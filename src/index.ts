#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from 'dotenv';
import { resolveClientCredentials } from "./credentials.js";

dotenv.config();

// Polyfill fetch for older Node.js versions or environments without native fetch
// This must be done before any fetch calls are made
let fetchImpl: typeof fetch;

async function ensureFetch(): Promise<typeof fetch> {
  if (fetchImpl) return fetchImpl;

  if (typeof globalThis.fetch !== 'undefined') {
    fetchImpl = globalThis.fetch;
  } else {
    // Dynamically import node-fetch as fallback
    const nodeFetch = await import('node-fetch');
    fetchImpl = nodeFetch.default as unknown as typeof fetch;
  }
  return fetchImpl;
}

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
  const { workspaceId, apiKey } = resolveClientCredentials();
  const fetch = await ensureFetch();
  const response = await fetch('https://mcp-server.nubis.app/' + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      apiKey,
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
  "Retrieve all project branches (boltz) for the workspace. Boltz are like sprints or project phases that group related tasks. Use this first to get bolt_id values for filtering tasks by project area. Returns: id, name, description, status for each bolt.",
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
  "List tasks from the workspace kanban board. Returns task details including title, description, board status, GitHub file references, blockers, and images. Use board filter to see tasks by status, bolt_id to filter by project area. Start here to find tasks to work on.",
  {
    limit: z.number().optional().default(5).describe("Maximum tasks to return (default: 5)"),
    board: z.enum(['bugs', 'backlog', 'priority', 'in-progress', 'reviewing', 'completed']).optional().describe("Filter by kanban board: bugs=issues, backlog=planned, priority=up next, in-progress=active, reviewing=needs review, completed=done"),
    bolt_id: z.string().optional().describe("Filter by bolt/project branch UUID (get from get_boltz)"),
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

/**
 * Get Task Details -> Get a task by ID
 */
server.tool(
  "get_task_details",
  "Get complete details for a single task including subtasks, comments, and blocker information. Use after get_tasks to dive deeper into a specific task. Returns full task object with nested subtasks and comments arrays.",
  {
    taskID: z.string().describe("UUID of the task to retrieve"),
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

/**
 * Get Task Context -> Get context for a task
 */
server.tool(
  "get_task_context",
  "Retrieve implementation notes and context saved for a task. Context contains developer notes, code snippets, decisions, or any text added via add_context_to_task. Use to understand previous work or decisions on a task.",
  {
    taskID: z.string().describe("UUID of the task"),
  },
  async ({ taskID }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_task_context',
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

//add_context_to_pm_task
/**
 * Always ADD CONTEXT TO PM TASK
 */
server.tool(
  "add_context_to_task",
  "Save implementation notes, code context, or developer notes to a task. Use this to document decisions, add code snippets, or save progress notes that will help future work on this task. Context is appended (not replaced).",
  {
    taskID: z.string().describe("UUID of the task to add context to"),
    context: z.string().describe("Text content to save - can include code snippets, notes, decisions, or any relevant information"),
  },
  async ({ taskID, context }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'add_context_to_task',
      schema: {
        taskID,
        context
      }
    });
    if (!json.data) throw new Error('No data returned from middleware');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ taskID, context }),
        },
        {
          type: "text",
          text: `API Usage: ${JSON.stringify({ taskID, context })}`,
        }
      ],
    };
  }
);

// Get Task Images -> Get images for a task
server.tool(
  "get_task_images",
  "Retrieve image attachments for a task. Returns URLs of images attached to the task, useful for viewing mockups, screenshots, or design references. Use when you need to see visual context for a task.",
  {
    taskID: z.string().describe("UUID of the task to get images for"),
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Work on Task -> Work on a task
server.tool(
  "work_on_task",
  "Start working on a task. Fetches full task details and checks for blockers. If the task has unresolved blockers, returns an error with blocker IDs. Use this when ready to begin implementation - it provides all context needed and validates the task is ready to work on.",
  {
    taskID: z.string().describe("UUID of the task to work on"),
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
            text: `API Usage: ${JSON.stringify(taskData.api_usage)}`,
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
          text: `You are assisting with task management in Nubis. Your task is to work on the user's requested task based on the following details:\n\n**Task Instruction**: Process and update the task with the provided information.\n\n**Task ID**: ${taskID}\n\n**Task Details**: \n      ${JSON.stringify(json.data, null, 2).replace(/"/g, '').replace(/:/g, ': ').replace(/},/g, ',\n')}\n      \n      Please analyze the details, perform the requested action (e.g., update description, add subtask), and return a response indicating the action taken.`,
        },
        {
          type: "text",
          user: "NUBIS",
          text: `Prompt user to move this task to 'in-progress' if it is not already in progress.`,
        },
        
        {
          type: "text",
          user: "NUBIS",
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Explain setup and what user needs to do for feature to be implemented
/* server.tool(
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
); */

// Move Task -> Move a task to ['backlog', 'priority', 'in-progress','reviewing', 'completed']
server.tool(
  "move_task",
  "Move a task to a different kanban board column. Use to update task status as work progresses: backlog (planned) -> priority (up next) -> in-progress (active) -> reviewing (needs review) -> completed (done).",
  {
    taskID: z.string().describe("UUID of the task to move"),
    board: z.enum(['backlog', 'priority', 'in-progress','reviewing', 'completed']).describe("Target board: backlog=planned, priority=up next, in-progress=active work, reviewing=needs review, completed=done"),
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Create Task -> Create a new task
server.tool(
  "create_task",
  "Create a new task or subtask in the workspace. Tasks are created in backlog by default. Link to GitHub files/directories to associate code with tasks. Use parent_task_id to create subtasks under a parent task.",
  {
    title: z.string().describe("Task title - brief description of what needs to be done"),
    description: z.string().optional().describe("Detailed description, acceptance criteria, or implementation notes"),
    board: z.enum(['backlog', 'bugs', 'in-progress', 'priority', 'reviewing', 'completed']).optional().default('backlog').describe("Initial board placement (default: backlog)"),
    parent_task_id: z.string().optional().describe("UUID of parent task - makes this a subtask"),
    github_item_type: z.string().optional().describe("Type of GitHub reference: 'file' or 'dir'"),
    github_file_path: z.string().optional().describe("Path in repo, e.g., 'src/components/Modal.tsx'"),
    github_repo_name: z.string().optional().describe("Repository in format 'owner/repo', e.g., 'Atomlaunch/nubis'"),
    bolt_id: z.string().optional().describe("UUID of bolt/project branch to assign task to")
  },
  async ({ title, description, board, parent_task_id, github_item_type, github_file_path, github_repo_name, bolt_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'create_task',
      schema: {
        title,
        description,
        board,
        parent_task_id,
        github_item_type,
        github_file_path,
        github_repo_name,
        bolt_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Update Task -> Update an existing task
server.tool(
  "update_task",
  "Update an existing task's properties. Only provide fields you want to change - others remain unchanged. Can update title, description, board, GitHub references, and parent/bolt assignments.",
  {
    taskID: z.string().describe("UUID of the task to update"),
    title: z.string().optional().describe("New task title"),
    description: z.string().optional().describe("New description"),
    board: z.enum(['backlog', 'bugs', 'in-progress', 'priority', 'reviewing', 'completed']).optional().describe("Move to different board"),
    bolt_id: z.string().optional().describe("Assign to different bolt/project branch"),
    parent_task_id: z.string().optional().describe("Change parent task (for subtasks)"),
    github_item_type: z.string().optional().describe("Type: 'file' or 'dir'"),
    github_file_path: z.string().optional().describe("Path in repo"),
    github_repo_name: z.string().optional().describe("Repository in 'owner/repo' format"),
  },
  async ({ taskID, title, description, board, bolt_id, parent_task_id, github_item_type, github_file_path, github_repo_name }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'update_task',
      schema: {
        taskID,
        title,
        description,
        board,
        bolt_id,
        parent_task_id,
        github_item_type,
        github_file_path,
        github_repo_name
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Delete Task -> Delete a single task in the authenticated workspace
server.tool(
  "delete_task",
  "Delete a single task from the authenticated workspace. Related comments, labels, blockers, commits, and assignments are removed with the task. Returns the deleted task, or reports the ID as missing if it is not in this workspace. Never deletes across workspaces.",
  {
    taskID: z.string().describe("UUID of the task to delete"),
  },
  async ({ taskID }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'delete_task',
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Delete Tasks -> Delete multiple tasks in the authenticated workspace
server.tool(
  "delete_tasks",
  "Delete multiple tasks from the authenticated workspace. Missing or other-workspace IDs are reported without failing the rest of the batch. Related comments, labels, blockers, commits, and assignments are removed with each deleted task. Never deletes across workspaces.",
  {
    taskIDs: z.array(z.string()).describe("UUIDs of the tasks to delete"),
  },
  async ({ taskIDs }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'delete_tasks',
      schema: {
        taskIDs
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Add Comment -> Add a comment to a task
server.tool(
  "add_comment",
  "Add a comment to a task for discussion or status updates. Comments are visible to all workspace members.",
  {
    taskID: z.string().describe("UUID of the task to comment on"),
    content: z.string().describe("Comment text"),
    parent_id: z.string().optional().describe("UUID of parent comment for replies")
  },
  async ({ taskID, content, parent_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'add_comment',
      schema: {
        taskID,
        content,
        parent_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Add Blocker -> Mark a task as blocked by another
server.tool(
  "add_blocker",
  "Mark a task as blocked by another task. The blocked task cannot be worked on until the blocker is resolved (moved to completed).",
  {
    taskID: z.string().describe("UUID of the task being blocked"),
    blocker_task_id: z.string().describe("UUID of the blocking task")
  },
  async ({ taskID, blocker_task_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'add_blocker',
      schema: {
        taskID,
        blocker_task_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Remove Blocker -> Remove a blocking relationship
server.tool(
  "remove_blocker",
  "Remove a blocking dependency, allowing the task to be worked on.",
  {
    taskID: z.string().describe("UUID of the blocked task"),
    blocker_task_id: z.string().describe("UUID of the blocker to remove")
  },
  async ({ taskID, blocker_task_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'remove_blocker',
      schema: {
        taskID,
        blocker_task_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Get Labels -> List all workspace labels
server.tool(
  "get_labels",
  "List all labels available in the workspace for categorizing tasks. Returns label name, color, and description.",
  {},
  async () => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_labels',
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Add Label to Task -> Add a label to a task
server.tool(
  "add_label_to_task",
  "Add a label to a task for categorization. Get available labels with get_labels first.",
  {
    taskID: z.string().describe("UUID of the task"),
    label_id: z.string().describe("UUID of the label to add")
  },
  async ({ taskID, label_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'add_label_to_task',
      schema: {
        taskID,
        label_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Remove Label from Task -> Remove a label from a task
server.tool(
  "remove_label_from_task",
  "Remove a label from a task.",
  {
    taskID: z.string().describe("UUID of the task"),
    label_id: z.string().describe("UUID of the label to remove")
  },
  async ({ taskID, label_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'remove_label_from_task',
      schema: {
        taskID,
        label_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Get Task Commits -> Get git commits linked to a task
server.tool(
  "get_task_commits",
  "Get all git commits linked to a task. Shows commit SHA, message, author, and date.",
  {
    taskID: z.string().describe("UUID of the task")
  },
  async ({ taskID }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_task_commits',
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Link Commit to Task -> Link a git commit to a task
server.tool(
  "link_commit_to_task",
  "Link a git commit to a task for traceability. Associates code changes with task work.",
  {
    taskID: z.string().describe("UUID of the task"),
    commit_sha: z.string().describe("Git commit SHA"),
    repo_name: z.string().describe("Repository in 'owner/repo' format"),
    commit_message: z.string().optional().describe("Commit message"),
    commit_author: z.string().optional().describe("Commit author name")
  },
  async ({ taskID, commit_sha, repo_name, commit_message, commit_author }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'link_commit_to_task',
      schema: {
        taskID,
        commit_sha,
        repo_name,
        commit_message,
        commit_author
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Get Teams -> List workspace teams
server.tool(
  "get_teams",
  "List all teams in the workspace. Returns team name, description, and color.",
  {},
  async () => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_teams',
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
        }
      ],
    };
  }
);

// Get Team Members -> Get members of a team
server.tool(
  "get_team_members",
  "Get all members of a team with their roles and profile info.",
  {
    team_id: z.string().describe("UUID of the team")
  },
  async ({ team_id }) => {
    const json = await getResultsFromMiddleware({
      endpoint: 'get_team_members',
      schema: {
        team_id
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
          text: `API Usage: ${JSON.stringify(json.api_usage)}`,
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