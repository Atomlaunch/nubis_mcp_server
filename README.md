# Nubis MCP Server

## What is MCP?

The Model Context Protocol (MCP) is a standardized interface that allows AI models to access external tools and data sources. This server implements the MCP specification to provide AI assistants with access to Nubis task management functionality.

## Installation

```bash
npx -y @lil2good/nubis-mcp-server@latest --workspaceID <your-workspace-id> --access-token <your-api-key>
```

## Available Tools

This MCP server provides the following tools:

### `get_tasks`
Retrieves a list of tasks for a workspace with optional filtering by board.

```
Parameters:
- limit: number (optional, default: 5)
- board: 'bugs' | 'backlog' | 'priority' | 'in-progress' | 'reviewing' | 'completed' (optional)
```

### `get_task`
Gets detailed information about a specific task by ID.

```
Parameters:
- taskID: string (required)
```

### `get_task_images`
Retrieves images associated with a specific task.

```
Parameters:
- taskID: string (required)
```

### `work_on_task`
Moves a task to the "in-progress" board and returns task details.

```
Parameters:
- taskID: string (required)
```

### `explain_setup`
Provides information about what needs to be done to implement a feature based on task details.

```
Parameters:
- taskID: string (required)
```

### `move_task`
Moves a task to a different board.

```
Parameters:
- taskID: string (required)
- board: 'backlog' | 'in-progress' | 'reviewing' | 'completed' (required)
```

### `delete_task`
Deletes a single task in the authenticated workspace. Related comments, labels, blockers, commits, and assignments are removed with the task. Missing IDs are reported instead of failing. Never deletes across workspaces.

```
Parameters:
- taskID: string (required) — UUID of the task to delete

Returns:
- deleted: { id, title, task_number, board } | null
- missing: string[] — IDs not found in this workspace
```

### `delete_tasks`
Deletes multiple tasks in the authenticated workspace. If some IDs are missing, those are reported and the rest of the batch still deletes. Never deletes across workspaces.

```
Parameters:
- taskIDs: string[] (required) — UUIDs of the tasks to delete

Returns:
- deleted: { id, title, task_number, board }[]
- missing: string[] — IDs not found in this workspace
```

## Configuration in AI Tools

To use this MCP server with AI assistants that support MCP, add the following configuration:

```json
"nubis": {
  "command": "npx",
  "args": [
    "-y",
    "@lil2good/nubis-mcp-server@latest"
  ],
  "env": {
    "NUBIS_API_KEY": "<YOUR_API_KEY>",
    "NUBIS_WORKSPACE_ID": "<YOUR_WORKSPACE_ID>"
  }
}
```

## Security

This MCP server uses a secure middleware architecture that keeps your API credentials safe. All privileged operations are performed through a secure server, while the MCP interface remains lightweight and secure for public distribution.