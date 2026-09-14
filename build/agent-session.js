/**
 * Agent session middleware (not an MCP tool).
 * Exchanges NUBIS_AGENT_KEY for a GoTrue JWT via POST /agent-session and
 * caches it in process memory. Subsequent tool POSTs send Bearer JWT only.
 * Edge `agent-token` is password grant — not generateLink / magic-link.
 */
import { resolveClientCredentials } from "./credentials.js";
const MCP_BASE_URL = "https://mcp-server.nubis.app";
const REFRESH_SKEW_MS = 30_000;
let cached = null;
let inFlight = null;
export function clearAgentSessionCache() {
    cached = null;
}
function sessionFromPayload(payload) {
    const accessToken = (typeof payload.access_token === "string" && payload.access_token) ||
        (typeof payload.accessToken === "string" && payload.accessToken) ||
        "";
    if (!accessToken) {
        throw new Error("Agent session did not return access_token. Edge agent-token may not be wired.");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    const user = payload.user && typeof payload.user === "object"
        ? payload.user
        : null;
    const userId = typeof user?.id === "string" ? user.id : undefined;
    const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
    return {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + Math.max(expiresIn, 60) * 1000,
        userId,
    };
}
function formatNotWired(status, body) {
    const parsed = body && typeof body === "object" ? body : null;
    const code = parsed?.code;
    const fn = parsed?.function;
    const message = (typeof parsed?.message === "string" && parsed.message) ||
        (typeof parsed?.error === "string" && parsed.error) ||
        JSON.stringify(body);
    if (status === 404 || status === 501 || code === "EDGE_NOT_WIRED") {
        return `Agent session failed (${status}): Edge function ${fn || "agent-token"} is not wired. ${message} Refusing to fall back to workspace api_keys + service role.`;
    }
    if (code === "AGENT_MODE_CONFIG") {
        return `Agent session is not configured (${status}): ${message}`;
    }
    return `Agent session failed (${status}): ${message}`;
}
export async function exchangeAgentSession(fetchImpl, agentKey) {
    const response = await fetchImpl(`${MCP_BASE_URL}/agent-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: agentKey }),
    });
    let payload = null;
    try {
        payload = await response.json();
    }
    catch {
        payload = { error: `Non-JSON response from /agent-session (${response.status})` };
    }
    if (!response.ok) {
        throw new Error(formatNotWired(response.status, payload));
    }
    return sessionFromPayload((payload || {}));
}
export async function getAgentAccessToken(fetchImpl) {
    const creds = resolveClientCredentials();
    if (creds.authKind !== "agent_key") {
        throw new Error("getAgentAccessToken requires NUBIS_AGENT_KEY");
    }
    if (cached && Date.now() < cached.expiresAt - REFRESH_SKEW_MS) {
        return cached.accessToken;
    }
    if (!inFlight) {
        inFlight = exchangeAgentSession(fetchImpl, creds.agentKey).finally(() => {
            inFlight = null;
        });
    }
    cached = await inFlight;
    return cached.accessToken;
}
export function invalidateAgentSession() {
    cached = null;
}
