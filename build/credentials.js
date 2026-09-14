/**
 * Resolve Nubis workspace + API key at request time.
 *
 * Cursor/npx connectors use several env names, and the README documents
 * `--workspaceID` / `--access-token`. JSON.stringify drops undefined keys, so
 * a missing snapshot at import used to POST a body with no workspaceId.
 *
 * Two key types (do not collapse):
 * - Workspace MCP key: NUBIS_API_KEY / --access-token (human Settings → MCP)
 * - Agent principal key: NUBIS_AGENT_KEY / --agent-key (nubis_ag_…)
 * Both set is a hard error so a human key cannot silently shadow an agent.
 */
const WORKSPACE_ENV_VARS = [
    "NUBIS_WORKSPACE_ID",
    "NUBIS_WORKSPACEID",
    "WORKSPACE_ID",
];
const API_KEY_ENV_VARS = [
    "NUBIS_API_KEY",
    "NUBIS_ACCESS_TOKEN",
    "ACCESS_TOKEN",
];
const AGENT_KEY_ENV_VARS = ["NUBIS_AGENT_KEY"];
function trimmed(value) {
    return typeof value === "string" ? value.trim() : "";
}
function firstEnv(env, keys) {
    for (const key of keys) {
        const value = trimmed(env[key]);
        if (value)
            return value;
    }
    return "";
}
/**
 * Read `--flag value` or `--flag=value` from argv. Values that look like
 * another flag are ignored so a bare `--workspaceID --access-token` is empty.
 */
export function argvFlag(flag, argv) {
    const eqPrefix = `${flag}=`;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === flag) {
            const next = argv[i + 1];
            if (!next || next.startsWith("-"))
                return "";
            return next.trim();
        }
        if (arg.startsWith(eqPrefix)) {
            return arg.slice(eqPrefix.length).trim();
        }
    }
    return "";
}
export function resolveClientCredentials(sources = {}) {
    const env = sources.env ?? process.env;
    const argv = sources.argv ?? process.argv;
    const workspaceId = argvFlag("--workspaceID", argv) || firstEnv(env, WORKSPACE_ENV_VARS);
    const apiKey = argvFlag("--access-token", argv) || firstEnv(env, API_KEY_ENV_VARS);
    const agentKey = argvFlag("--agent-key", argv) || firstEnv(env, AGENT_KEY_ENV_VARS);
    if (!workspaceId) {
        throw new Error("workspaceId is required. Set NUBIS_WORKSPACE_ID, NUBIS_WORKSPACEID, or WORKSPACE_ID, or pass --workspaceID.");
    }
    if (agentKey && apiKey) {
        throw new Error("Cannot set both a workspace API key (NUBIS_API_KEY / NUBIS_ACCESS_TOKEN / ACCESS_TOKEN / --access-token) and an agent key (NUBIS_AGENT_KEY / --agent-key). Use one.");
    }
    if (agentKey) {
        return { workspaceId, authKind: "agent_key", agentKey };
    }
    if (!apiKey) {
        throw new Error("apiKey is required. Set NUBIS_API_KEY, NUBIS_ACCESS_TOKEN, or ACCESS_TOKEN, or pass --access-token for human MCP; or set NUBIS_AGENT_KEY / --agent-key for an agent principal. Do not set both.");
    }
    return { workspaceId, authKind: "workspace_api_key", apiKey };
}
