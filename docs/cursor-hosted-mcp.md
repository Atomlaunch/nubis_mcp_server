# Cursor agents: hosted OAuth MCP

Resource: `https://mcp.nubis.app/mcp`

This is the OAuth broker (Streamable HTTP). It is not the stdio client (`npx @lil2good/nubis-mcp-server` + `NUBIS_API_KEY`).

## IDE / repo

Committed [`.cursor/mcp.json`](../.cursor/mcp.json):

```json
{
  "mcpServers": {
    "nubis": {
      "url": "https://mcp.nubis.app/mcp"
    }
  }
}
```

No `env`, headers, or client secrets. Cursor uses DCR (`application_type: native` when `cursor://` or loopback redirects are present). See [nubis_mcp_server#8](https://github.com/Atomlaunch/nubis_mcp_server/pull/8).

## Cloud Agents

`.cursor/mcp.json` does **not** provision Cloud Agents. Add the same HTTP URL under the MCP dropdown on [cursor.com/agents](https://cursor.com/agents) (personal) or Dashboard → Integrations & MCP (team). Enable it for the environment.

OAuth is per-user. If an agent only sees `mcp_auth`, Eric must complete sign-in and workspace consent. Do not inject API keys.

In the Nubis Project this server currently appears as namespace `nubis-remote`.

## Discovery (no secrets)

- Health: `GET https://mcp.nubis.app/health`
- Resource metadata: `GET https://mcp.nubis.app/.well-known/oauth-protected-resource`
- Authorization server: `https://mcp.nubis.app/oauth` (metadata at `https://mcp.nubis.app/oauth/.well-known/oauth-authorization-server`)
