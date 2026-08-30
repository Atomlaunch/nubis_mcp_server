# Objective

## Communication Protocol
Use these MCP tools to report progress:

| Tool | When |
|------|------|
| update_task(channel, task_id, status) | Update task status |
| create_task(channel, title) | Create a new task |
| reload_objective(tile_id) | Get latest objective |
| pause_task(channel, task_id, reason) | Pause a task |
| get_context(tile_id) | Read context files |
| notify(channel, message) | Send notification |

Your tile channel: tile:tile-396dcced-e79f-4ad6-9a18-3239d020dea5

## Rules
1. Re-read this file when you receive a reload signal
2. Update task status via MCP tools as you work
3. Call notify when you need human attention

Generated: 2026-08-30T18:52:09.602Z