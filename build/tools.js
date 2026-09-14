import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
/** A fresh server per transport/user. Credentials belong to the injected executor. */
export function createNubisMcpServer(getResultsFromMiddleware, allowTool = () => true) {
    const server = new McpServer({ name: "nubis-mcp-server", version: "1.0.64" });
    const mcpBoardEnum = z
        .enum([
        "inbox",
        "priority",
        "bugs",
        "in-progress",
        "reviewing",
        "done",
        "closed",
        "backlog",
        "completed",
    ])
        .describe("Kanban board. Live keys: inbox, priority, bugs, in-progress, reviewing, done, closed. Aliases: backlog→inbox, completed→done.");
    for (const tool of ["get_projects", "get_task_boards"]) {
        if (allowTool(tool))
            server.tool(tool, tool === "get_projects"
                ? "List projects in this workspace. Use their IDs with task tools."
                : "List project workflow boards and ordered columns. Use column UUIDs for exact task placement; behavior identifies completion.", { project_id: z.string().uuid().optional() }, async (input) => {
                const json = await getResultsFromMiddleware({
                    endpoint: tool,
                    schema: input,
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(json.data) }],
                };
            });
    }
    // Get Boltz -> to save IDs for use in tasks later
    if (allowTool("get_boltz")) {
        server.tool("get_boltz", "Retrieve all project branches (boltz) for the workspace. Boltz are like sprints or project phases that group related tasks. Use this first to get bolt_id values for filtering tasks by project area. Returns: id, name, description, status for each bolt.", async () => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_boltz",
                schema: {},
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Get Tasks -> Get tasks for a workspace
    if (allowTool("get_tasks")) {
        server.tool("get_tasks", "List tasks from the workspace kanban board. Returns task details including title, description, board status, GitHub file references, blockers, and images. Use board filter to see tasks by status, bolt_id to filter by project area. Start here to find tasks to work on.", {
            project_id: z
                .string()
                .uuid()
                .nullable()
                .optional()
                .describe("Project UUID, not workspace ID; null means no project"),
            board_id: z
                .string()
                .uuid()
                .optional()
                .describe("Workflow board UUID from get_task_boards"),
            board_column_id: z
                .string()
                .uuid()
                .optional()
                .describe("Exact workflow column UUID; takes precedence over legacy board status"),
            limit: z
                .number()
                .optional()
                .default(5)
                .describe("Maximum tasks to return (default: 5)"),
            board: mcpBoardEnum.optional(),
            bolt_id: z
                .string()
                .optional()
                .describe("Filter by bolt/project branch UUID (get from get_boltz)"),
        }, async ({ project_id, board_id, board_column_id, limit, board, bolt_id, }) => {
            try {
                const json = await getResultsFromMiddleware({
                    endpoint: "get_tasks",
                    schema: {
                        project_id,
                        board_id,
                        board_column_id,
                        board,
                        bolt_id,
                        limit,
                    },
                });
                if (!json.data)
                    throw new Error("No data returned from middleware");
                const taskContent = json.data.map((task) => ({
                    type: "text",
                    text: [
                        `---`,
                        `### ${task.title}`,
                        `**Task ID:** ${task.id}`,
                        `**Task Number:** ${task.task_number}`,
                        `**Legacy status:** ${task.board}`,
                        `**Project ID:** ${task.branch_id ?? "none"}`,
                        `**Workflow ID:** ${task.board_id ?? "none"}`,
                        `**Column ID:** ${task.board_column_id ?? "none"}`,
                        `**Bolt:** ${task.bolt && typeof task.bolt === "object" && !Array.isArray(task.bolt) && "name" in task.bolt && task.bolt.name ? task.bolt.name : "_No bolt_"}`,
                        `**Description:** ${task.description ? task.description : "_No description_"}`,
                        `**Path Type:** ${task.github_item_type ? task.github_item_type : "_No file path type_"}`,
                        `**File Path:** ${task.github_file_path ? task.github_file_path : "_No file path_"}`,
                        `**Repo Name:** ${task.github_repo_name ? task.github_repo_name : "_No repo name_"}`,
                        `**Blockers:** ${task.pm_task_blockers && task.pm_task_blockers.length > 0 ? task.pm_task_blockers.map((blocker) => blocker.blocker_task_id).join(", ") : "_No blockers_"}`,
                        task.images && task.images.length > 0
                            ? task.images.map((image) => image.url).join("\n")
                            : "_No images_",
                        `---`,
                    ].join("\n\n"),
                }));
                // Append quota and user info as additional content
                taskContent.push({
                    type: "text",
                    text: `Always provide API Usage information separately. Usage: ${JSON.stringify(json.api_usage)}`,
                });
                return {
                    content: taskContent,
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                throw new Error(errorMessage);
            }
        });
    }
    /**
     * Get Task Details -> Get a task by ID
     */
    if (allowTool("get_task_details")) {
        server.tool("get_task_details", "Get complete details for a single task including subtasks, comments, and blocker information. Use after get_tasks to dive deeper into a specific task. Returns full task object with nested subtasks and comments arrays.", {
            taskID: z.string().describe("UUID of the task to retrieve"),
        }, async ({ taskID }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_task",
                schema: {
                    taskID,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    /**
     * Get Task Context -> Get context for a task
     */
    if (allowTool("get_task_context")) {
        server.tool("get_task_context", "Retrieve implementation notes and context saved for a task. Context contains developer notes, code snippets, decisions, or any text added via add_context_to_task. Use to understand previous work or decisions on a task.", {
            taskID: z.string().describe("UUID of the task"),
        }, async ({ taskID }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_task_context",
                schema: {
                    taskID,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    //add_context_to_pm_task
    /**
     * Always ADD CONTEXT TO PM TASK
     */
    if (allowTool("add_context_to_task")) {
        server.tool("add_context_to_task", "Save implementation notes, code context, or developer notes to a task. Use this to document decisions, add code snippets, or save progress notes that will help future work on this task. Context is appended (not replaced).", {
            taskID: z.string().describe("UUID of the task to add context to"),
            context: z
                .string()
                .describe("Text content to save - can include code snippets, notes, decisions, or any relevant information"),
        }, async ({ taskID, context }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "add_context_to_task",
                schema: {
                    taskID,
                    context,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Get Task Images -> Get images for a task
    if (allowTool("get_task_images")) {
        server.tool("get_task_images", "Retrieve image attachments for a task. Returns URLs of images attached to the task, useful for viewing mockups, screenshots, or design references. Use when you need to see visual context for a task.", {
            taskID: z.string().describe("UUID of the task to get images for"),
        }, async ({ taskID }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_task_images",
                schema: {
                    taskID,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Work on Task -> Work on a task
    if (allowTool("work_on_task")) {
        server.tool("work_on_task", "Start working on a task. Fetches full task details and checks for blockers. If the task has unresolved blockers, returns an error with blocker IDs. Use this when ready to begin implementation - it provides all context needed and validates the task is ready to work on.", {
            taskID: z.string().describe("UUID of the task to work on"),
        }, async ({ taskID }) => {
            // Step 1: Fetch task details
            const taskData = await getResultsFromMiddleware({
                endpoint: "get_task",
                schema: { taskID },
            });
            if (!taskData.data)
                throw new Error("No data returned from middleware");
            // Step 2: Check for blockers
            if (Array.isArray(taskData.data.pm_task_blockers) &&
                taskData.data.pm_task_blockers.length > 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Task ${taskID} cannot be worked on because it has blockers: ${taskData.data.pm_task_blockers.map((b) => b.blocker_task_id).join(", ")}. Please resolve all blockers before proceeding.`,
                        },
                        {
                            type: "text",
                            text: `API Usage: ${JSON.stringify(taskData.api_usage)}`,
                        },
                    ],
                };
            }
            const json = await getResultsFromMiddleware({
                endpoint: "work_on_task",
                schema: {
                    taskID,
                },
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `You are assisting with task management in Nubis. Your task is to work on the user's requested task based on the following details:\n\n**Task Instruction**: Process and update the task with the provided information.\n\n**Task ID**: ${taskID}\n\n**Task Details**: \n      ${JSON.stringify(json.data, null, 2)}\n      \n      Please analyze the details, perform the requested action (e.g., update description, add subtask), and return a response indicating the action taken.`,
                    },
                    {
                        type: "text",
                        text: `Prompt user to move this task to 'in-progress' if it is not already in progress.`,
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
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
    if (allowTool("move_task")) {
        server.tool("move_task", "Move a task to a different kanban board column. Live keys: inbox, priority, bugs, in-progress, reviewing, done, closed. Aliases: backlog→inbox, completed→done.", {
            project_id: z
                .string()
                .uuid()
                .nullable()
                .optional()
                .describe("Project UUID, not workspace ID; null means no project"),
            board_id: z
                .string()
                .uuid()
                .optional()
                .describe("Workflow board UUID from get_task_boards"),
            board_column_id: z
                .string()
                .uuid()
                .optional()
                .describe("Exact workflow column UUID; takes precedence over legacy board status"),
            taskID: z.string().describe("UUID of the task to move"),
            board: mcpBoardEnum.optional(),
        }, async ({ project_id, board_id, board_column_id, taskID, board }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "move_task",
                schema: {
                    project_id,
                    board_id,
                    board_column_id,
                    taskID,
                    board,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Create Task -> Create a new task
    if (allowTool("create_task")) {
        server.tool("create_task", "Create a new task or subtask in the workspace. Tasks are created in inbox by default. Link to GitHub files/directories to associate code with tasks. Use parent_task_id to create subtasks under a parent task.", {
            assignee_id: z
                .string()
                .uuid()
                .nullable()
                .optional()
                .describe("Assign a workspace member, or null to unassign"),
            project_id: z
                .string()
                .uuid()
                .nullable()
                .optional()
                .describe("Project UUID, not workspace ID; null means no project"),
            board_id: z
                .string()
                .uuid()
                .optional()
                .describe("Workflow board UUID from get_task_boards"),
            board_column_id: z
                .string()
                .uuid()
                .optional()
                .describe("Exact workflow column UUID; takes precedence over legacy board status"),
            title: z
                .string()
                .describe("Task title - brief description of what needs to be done"),
            description: z
                .string()
                .optional()
                .describe("Detailed description, acceptance criteria, or implementation notes"),
            board: mcpBoardEnum
                .optional()
                .describe("Initial board placement (default: inbox; backlog maps to inbox)"),
            parent_task_id: z
                .string()
                .optional()
                .describe("UUID of parent task - makes this a subtask"),
            github_item_type: z
                .string()
                .optional()
                .describe("Type of GitHub reference: 'file' or 'dir'"),
            github_file_path: z
                .string()
                .optional()
                .describe("Path in repo, e.g., 'src/components/Modal.tsx'"),
            github_repo_name: z
                .string()
                .optional()
                .describe("Repository in format 'owner/repo', e.g., 'Atomlaunch/nubis'"),
            bolt_id: z
                .string()
                .optional()
                .describe("UUID of bolt/project branch to assign task to"),
        }, async ({ assignee_id, project_id, board_id, board_column_id, title, description, board, parent_task_id, github_item_type, github_file_path, github_repo_name, bolt_id, }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "create_task",
                schema: {
                    assignee_id,
                    project_id,
                    board_id,
                    board_column_id,
                    title,
                    description,
                    board,
                    parent_task_id,
                    github_item_type,
                    github_file_path,
                    github_repo_name,
                    bolt_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Update Task -> Update an existing task
    if (allowTool("update_task")) {
        server.tool("update_task", "Update an existing task's properties. Only provide fields you want to change - others remain unchanged. Can update title, description, board, GitHub references, and parent/bolt assignments.", {
            assignee_id: z
                .string()
                .uuid()
                .nullable()
                .optional()
                .describe("Assign a workspace member, or null to unassign"),
            project_id: z
                .string()
                .uuid()
                .nullable()
                .optional()
                .describe("Project UUID, not workspace ID; null means no project"),
            board_id: z
                .string()
                .uuid()
                .optional()
                .describe("Workflow board UUID from get_task_boards"),
            board_column_id: z
                .string()
                .uuid()
                .optional()
                .describe("Exact workflow column UUID; takes precedence over legacy board status"),
            taskID: z.string().describe("UUID of the task to update"),
            title: z.string().optional().describe("New task title"),
            description: z.string().optional().describe("New description"),
            board: mcpBoardEnum.optional().describe("Move to a different board"),
            bolt_id: z
                .string()
                .optional()
                .describe("Assign to different bolt/project branch"),
            parent_task_id: z
                .string()
                .optional()
                .describe("Change parent task (for subtasks)"),
            github_item_type: z
                .string()
                .optional()
                .describe("Type: 'file' or 'dir'"),
            github_file_path: z.string().optional().describe("Path in repo"),
            github_repo_name: z
                .string()
                .optional()
                .describe("Repository in 'owner/repo' format"),
        }, async ({ assignee_id, project_id, board_id, board_column_id, taskID, title, description, board, bolt_id, parent_task_id, github_item_type, github_file_path, github_repo_name, }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "update_task",
                schema: {
                    assignee_id,
                    project_id,
                    board_id,
                    board_column_id,
                    taskID,
                    title,
                    description,
                    board,
                    bolt_id,
                    parent_task_id,
                    github_item_type,
                    github_file_path,
                    github_repo_name,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Delete Task -> Delete a single task in the authenticated workspace
    if (allowTool("delete_task")) {
        server.tool("delete_task", "Delete a single task from the authenticated workspace. Related comments, labels, blockers, commits, and assignments are removed with the task. Returns the deleted task, or reports the ID as missing if it is not in this workspace. Never deletes across workspaces.", {
            taskID: z.string().describe("UUID of the task to delete"),
        }, async ({ taskID }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "delete_task",
                schema: {
                    taskID,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Delete Tasks -> Delete multiple tasks in the authenticated workspace
    if (allowTool("delete_tasks")) {
        server.tool("delete_tasks", "Delete multiple tasks from the authenticated workspace. Missing or other-workspace IDs are reported without failing the rest of the batch. Related comments, labels, blockers, commits, and assignments are removed with each deleted task. Never deletes across workspaces.", {
            taskIDs: z.array(z.string()).describe("UUIDs of the tasks to delete"),
        }, async ({ taskIDs }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "delete_tasks",
                schema: {
                    taskIDs,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Add Comment -> Add a comment to a task
    if (allowTool("add_comment")) {
        server.tool("add_comment", "Add a comment to a task for discussion or status updates. Comments are visible to all workspace members.", {
            taskID: z.string().describe("UUID of the task to comment on"),
            content: z.string().describe("Comment text"),
            parent_id: z
                .string()
                .optional()
                .describe("UUID of parent comment for replies"),
        }, async ({ taskID, content, parent_id }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "add_comment",
                schema: {
                    taskID,
                    content,
                    parent_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Add Blocker -> Mark a task as blocked by another
    if (allowTool("add_blocker")) {
        server.tool("add_blocker", "Mark a task as blocked by another task. The blocked task cannot be worked on until the blocker is resolved (moved to done).", {
            taskID: z.string().describe("UUID of the task being blocked"),
            blocker_task_id: z.string().describe("UUID of the blocking task"),
        }, async ({ taskID, blocker_task_id }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "add_blocker",
                schema: {
                    taskID,
                    blocker_task_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Remove Blocker -> Remove a blocking relationship
    if (allowTool("remove_blocker")) {
        server.tool("remove_blocker", "Remove a blocking dependency, allowing the task to be worked on.", {
            taskID: z.string().describe("UUID of the blocked task"),
            blocker_task_id: z.string().describe("UUID of the blocker to remove"),
        }, async ({ taskID, blocker_task_id }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "remove_blocker",
                schema: {
                    taskID,
                    blocker_task_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Get Labels -> List all workspace labels
    if (allowTool("get_labels")) {
        server.tool("get_labels", "List all labels available in the workspace for categorizing tasks. Returns label name, color, and description.", {}, async () => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_labels",
                schema: {},
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Add Label to Task -> Add a label to a task
    if (allowTool("add_label_to_task")) {
        server.tool("add_label_to_task", "Add a label to a task for categorization. Get available labels with get_labels first.", {
            taskID: z.string().describe("UUID of the task"),
            label_id: z.string().describe("UUID of the label to add"),
        }, async ({ taskID, label_id }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "add_label_to_task",
                schema: {
                    taskID,
                    label_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Remove Label from Task -> Remove a label from a task
    if (allowTool("remove_label_from_task")) {
        server.tool("remove_label_from_task", "Remove a label from a task.", {
            taskID: z.string().describe("UUID of the task"),
            label_id: z.string().describe("UUID of the label to remove"),
        }, async ({ taskID, label_id }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "remove_label_from_task",
                schema: {
                    taskID,
                    label_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Get Task Commits -> Get git commits linked to a task
    if (allowTool("get_task_commits")) {
        server.tool("get_task_commits", "Get all git commits linked to a task. Shows commit SHA, message, author, and date.", {
            taskID: z.string().describe("UUID of the task"),
        }, async ({ taskID }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_task_commits",
                schema: {
                    taskID,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Link Commit to Task -> Link a git commit to a task
    if (allowTool("link_commit_to_task")) {
        server.tool("link_commit_to_task", "Link a git commit to a task for traceability. Associates code changes with task work.", {
            taskID: z.string().describe("UUID of the task"),
            commit_sha: z.string().describe("Git commit SHA"),
            repo_name: z.string().describe("Repository in 'owner/repo' format"),
            commit_message: z.string().optional().describe("Commit message"),
            commit_author: z.string().optional().describe("Commit author name"),
        }, async ({ taskID, commit_sha, repo_name, commit_message, commit_author, }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "link_commit_to_task",
                schema: {
                    taskID,
                    commit_sha,
                    repo_name,
                    commit_message,
                    commit_author,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Get Teams -> List workspace teams
    if (allowTool("get_teams")) {
        server.tool("get_teams", "List all teams in the workspace. Returns team name, description, and color.", {}, async () => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_teams",
                schema: {},
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    // Get Team Members -> Get members of a team
    if (allowTool("get_team_members")) {
        server.tool("get_team_members", "Get all members of a team with their roles and profile info.", {
            team_id: z.string().describe("UUID of the team"),
        }, async ({ team_id }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "get_team_members",
                schema: {
                    team_id,
                },
            });
            if (!json.data)
                throw new Error("No data returned from middleware");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(json.data),
                    },
                    {
                        type: "text",
                        text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                    },
                ],
            };
        });
    }
    function jsonToolContent(json) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(json.data),
                },
                {
                    type: "text",
                    text: `API Usage: ${JSON.stringify(json.api_usage)}`,
                },
            ],
        };
    }
    if (allowTool("list_agent_memberships")) {
        server.tool("list_agent_memberships", "List workspaces this agent principal is a member of (own pm_members rows for auth.uid()).", {}, async () => {
            const json = await getResultsFromMiddleware({
                endpoint: "list_agent_memberships",
                schema: {},
            });
            return jsonToolContent(json);
        });
    }
    if (allowTool("mint_agent")) {
        server.tool("mint_agent", "Mint a new agent principal in this workspace via Edge invite-agent. Agent admin only; new agents are members (not admin/owner). Human owner/admin mint and rotate/revoke in Settings. Returns the plaintext key once — do not log it. 501 until invite-agent is wired.", {
            display_name: z
                .string()
                .optional()
                .describe("Display name for the new agent"),
        }, async ({ display_name }) => {
            const json = await getResultsFromMiddleware({
                endpoint: "mint_agent",
                schema: { display_name, role: "member" },
            });
            return jsonToolContent(json);
        });
    }
    return server;
}
