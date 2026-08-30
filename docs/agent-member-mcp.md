# MCP server: agent members (v1)

| Field | Value |
| --- | --- |
| Status | Implementation note. Canonical product spec is PMTool `.audit/design-teams-human-agent-members.md`. |
| Date | 2026-08-30 |
| This repo | `@lil2good/nubis-mcp-server` (`/home/thedev/Projects/nubis_mcp_server`) |
| Package | `package.json` version **1.0.64** |
| Out of scope | WebMCP `document.modelContext`. Do not wrap this server as WebMCP. Do not npm publish from this slice. |

v1 mint is **new principal per invite**. Agents join in Settings via Edge `invite-agent`. After mint, the agent is already a `pm_members` row. Unlinked agent keys get **403** on workspace tools. There is no pending-request / approve path.

## Auth: two exclusive keys

| | Workspace MCP key | Agent principal key |
| --- | --- | --- |
| Table | `api_keys` | `pm_agent_keys.key_hash` |
| Env | `NUBIS_API_KEY` | `NUBIS_AGENT_KEY` (`nubis_ag_…`) |
| Workspace | `NUBIS_WORKSPACE_ID` required | Same, out of band |
| Session | None; middleware looks up `api_keys.user_id` | `agent-token` → GoTrue JWT (`auth.uid()` = agent profile) |

- Both keys set: **hard-error** (`src/credentials.ts`).
- HTTP `request-auth.ts`: prefix-detect `nubis_ag_`. Never SELECT `api_keys` for agent keys.
- Agent JWT via `POST /agent-session` (Edge `agent-token`, password grant). Missing Edge → 501 `not_wired`. Do **not** fall back to `api_keys` + service role.
- `isOwnerEquivalentRole` on the workspace-key path is **owner | admin** only. Do not add extra roles.

## Tools (stdio + HTTP)

Task tools stay as registered in `src/index.ts`. Board keys: live `inbox` / `done` / `closed`; aliases `backlog` → `inbox`, `completed` → `done`.

Agent-session tools:

| Tool | HTTP | Who |
| --- | --- | --- |
| `list_agent_memberships` | `POST /list_agent_memberships` | Agent JWT → own `pm_members` (`user_id = auth.uid()`) |
| `mint_agent` | `POST /mint_agent` | Agent **admin** only. Proxies Edge `invite-agent` with role **member**. Human owner/admin mint stays in Settings. |

`agent-token` is middleware, not a tool.

Settings-only (not MCP tools): rotate key, revoke agent, invite humans, change roles, mint agent **admins**.

## Unlinked agent

Valid `nubis_ag_` + workspace UUID but no `pm_members` row → **403** `AGENT_NOT_A_MEMBER` on workspace tools. `list_agent_memberships` may still list other workspaces the principal belongs to.
