# Nubis MCP Server

This MCP server exposes an endpoint to fetch `pm_tasks` from Supabase by `workspaceID` (branch_id).

## Features
- REST API: `GET /tasks/:workspaceID` returns all tasks for a workspace (branch).
- Strict TypeScript typing and project conventions.
- Ready for MCP extension (tools/resources).

## Setup
1. Copy `.env.example` to `.env` and fill in your Supabase credentials:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm run dev
   ```

## Endpoint
- `GET /tasks/:workspaceID` — Fetch all tasks for the given workspace (branch).

## Environment Variables
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Service Role Key (keep secret!)
- `PORT`: (optional) Port for the server (default: 3000)

---

This server is scaffolded for MCP compatibility and can be extended to expose MCP tools, resources, and prompts as needed.
