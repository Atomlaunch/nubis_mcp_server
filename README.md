# Nubis MCP Server

MCP server for Nubis task management. stdio process: `src/index.ts` → `POST https://mcp-server.nubis.app/<endpoint>`.

Do not wrap this package as WebMCP / `document.modelContext`.

```bash
npx -y @lil2good/nubis-mcp-server@latest --workspaceID <workspace-uuid> --access-token <workspace-api-key>
```

Workspace UUID is always required (out of band). Do not set both a workspace API key and an agent key.

## Auth modes

### Human / workspace MCP key

Settings → MCP. Env: `NUBIS_API_KEY` (aliases: `NUBIS_ACCESS_TOKEN`, `ACCESS_TOKEN`, argv `--access-token`).

```json
"nubis": {
  "command": "npx",
  "args": ["-y", "@lil2good/nubis-mcp-server@latest"],
  "env": {
    "NUBIS_API_KEY": "<workspace-mcp-key>",
    "NUBIS_WORKSPACE_ID": "<workspace-uuid>"
  }
}
```

### Agent principal key

Minted agent (`nubis_ag_…`). Env: `NUBIS_AGENT_KEY` (argv `--agent-key`). Workspace UUID still required. The process exchanges the key via `POST /agent-session` (Edge `agent-token`) and caches a JWT in memory. Tool calls send `Authorization: Bearer <jwt>`, never the raw agent key, and never look the key up in `api_keys`.

```json
"nubis": {
  "command": "npx",
  "args": ["-y", "@lil2good/nubis-mcp-server@latest"],
  "env": {
    "NUBIS_AGENT_KEY": "nubis_ag_…",
    "NUBIS_WORKSPACE_ID": "<workspace-uuid>"
  }
}
```

If both keys are set, the process hard-errors. If Edge `agent-token` is missing, agent mode fails with a 501 / `not_wired` error — it does not fall back to workspace `api_keys` + service role.

`agent-token` is **middleware** (password grant, not generateLink / magic-link). Do not call it from the model.

v1: an agent is already a workspace member after Settings **invite-agent**. Task tools then run as that agent JWT (`created_by` = agent uid). An agent key with no `pm_members` row for `NUBIS_WORKSPACE_ID` gets **403** on workspace tools. Rotate/revoke stay in Settings (human owner/admin). There is no `invite_human` tool.

## Board keys

Live keys: `inbox` | `priority` | `bugs` | `in-progress` | `reviewing` | `done` | `closed`.

Aliases (mapped before filter/write): `backlog` → `inbox`, `completed` → `done`. Exact-match filters use the live key, so `backlog` lists inbox rows.

## Tools

Registered in `src/index.ts` (stdio). HTTP routes use the same names as path `/<endpoint>` except `get_task_details` → `POST /get_task`.

### Tasks

| Tool | Purpose |
| --- | --- |
| `get_boltz` | List project branches (boltz) |
| `get_tasks` | List tasks (`limit`, `board`, `bolt_id`) |
| `get_task_details` | Full task including subtasks and comments |
| `get_task_context` | Saved implementation notes |
| `add_context_to_task` | Append context text to a task |
| `get_task_images` | Image URLs on a task |
| `work_on_task` | Fetch details and refuse if blockers exist |
| `move_task` | Move a task to a board |
| `create_task` | Create a task (default board `inbox`) |
| `update_task` | Patch task fields |
| `delete_task` | Delete one task in this workspace |
| `delete_tasks` | Delete many; missing IDs reported |
| `add_comment` | Comment on a task |
| `add_blocker` | Mark a task blocked by another |
| `remove_blocker` | Remove a blocker |
| `get_labels` | Workspace labels |
| `add_label_to_task` | Attach a label |
| `remove_label_from_task` | Detach a label |
| `get_task_commits` | Commits linked to a task |
| `link_commit_to_task` | Link a git commit |
| `get_teams` | Workspace teams |
| `get_team_members` | Members of a team |

### Agent membership

Require `NUBIS_AGENT_KEY` (agent session).

| Tool | Who | Notes |
| --- | --- | --- |
| `list_agent_memberships` | Agent JWT | Own `pm_members` rows for `auth.uid()` |
| `mint_agent` | Agent **admin** | New principal via Edge `invite-agent`, role **member** only. Plaintext key once; do not log. 501 until Edge is wired. Human owner/admin mint stays in Settings. |

Rotate and revoke are Settings-only (human owner/admin).

## HTTP middleware (operators)

`server/` is the privileged process behind `mcp-server.nubis.app`. Workspace keys still use `api_keys`. Agent keys are prefix-detected (`nubis_ag_`) and never selected from `api_keys`. Agent writes use the session JWT, not the service role.

Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and for agent mode `SUPABASE_ANON_KEY` plus PMTool Edge: `agent-token` (password grant), `invite-agent`. Missing Edge → HTTP 501 `not_wired`.

## Error monitoring (Sentry)

The HTTP process (`server/`) initializes `@sentry/node` only when `SENTRY_DSN` is set. There is no DSN in the repo. The stdio MCP client (`src/`) does not send to Sentry.

Set these on **Nubis: MCP Server** (Railway), not in git:

| Env var | Required | What it does |
| --- | --- | --- |
| `SENTRY_DSN` | Yes, to enable | Sentry project DSN. SDK no-ops if empty. |
| `SENTRY_ENVIRONMENT` | No | Event environment. Falls back to `RAILWAY_ENVIRONMENT_NAME`, then `NODE_ENV`. |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Trace sample rate 0–1. Default `0`. |
| `SENTRY_RELEASE` | No | Release name. |

Privacy: `sendDefaultPii` is off. Request bodies, cookies, `Authorization` / `x-api-key`, and Sentry `user` are stripped before send. Secrets in extras go through the same redaction as request logs.
