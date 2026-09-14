#!/usr/bin/env node
import { createNubisMcpServer } from "./tools.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import { resolveClientCredentials } from "./credentials.js";
import { mapSchemaBoard } from "./boards.js";
import { getAgentAccessToken, invalidateAgentSession, } from "./agent-session.js";
dotenv.config();
// Polyfill fetch for older Node.js versions or environments without native fetch
// This must be done before any fetch calls are made
let fetchImpl;
async function ensureFetch() {
    if (fetchImpl)
        return fetchImpl;
    if (typeof globalThis.fetch !== 'undefined') {
        fetchImpl = globalThis.fetch;
    }
    else {
        // Dynamically import node-fetch as fallback
        const nodeFetch = await import('node-fetch');
        fetchImpl = nodeFetch.default;
    }
    return fetchImpl;
}
const MCP_BASE_URL = "https://mcp-server.nubis.app/";
async function postMiddleware(fetchImpl, endpoint, workspaceId, schema, headers, extraBody) {
    return fetchImpl(MCP_BASE_URL + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
        body: JSON.stringify({
            workspaceId,
            schema,
            ...extraBody,
        }),
    });
}
function errorFromResponseBody(status, errorData) {
    const code = errorData?.code;
    const fn = errorData?.function;
    const message = errorData?.message ||
        errorData?.error ||
        "Failed to fetch from middleware";
    if (status === 404 || status === 501 || code === "EDGE_NOT_WIRED") {
        return new Error(`not_wired (${status}): ${fn || endpointHint(errorData)} — ${message}`);
    }
    if (code === "AGENT_MODE_CONFIG") {
        return new Error(`agent_mode_not_configured (${status}): ${message}`);
    }
    return new Error(typeof message === "string" ? message : JSON.stringify(errorData));
}
function endpointHint(errorData) {
    return typeof errorData?.function === "string" ? errorData.function : "edge";
}
// Helper to get results from middleware.
// Agent mode: session middleware exchanges NUBIS_AGENT_KEY once, then sends Bearer JWT.
async function getResultsFromMiddleware({ endpoint, schema }) {
    const creds = resolveClientCredentials();
    const fetchImpl = await ensureFetch();
    const mappedSchema = schema && typeof schema === "object" ? mapSchemaBoard(schema) : schema;
    async function send(retried) {
        let headers = {};
        let extraBody = {};
        if (creds.authKind === "agent_key") {
            const accessToken = await getAgentAccessToken(fetchImpl);
            headers = { Authorization: `Bearer ${accessToken}` };
        }
        else {
            extraBody = { apiKey: creds.apiKey };
        }
        const response = await postMiddleware(fetchImpl, endpoint, creds.workspaceId, mappedSchema, headers, extraBody);
        let errorData = null;
        if (!response.ok) {
            try {
                errorData = await response.json();
            }
            catch {
                errorData = { error: `HTTP ${response.status}` };
            }
            if (creds.authKind === "agent_key" &&
                response.status === 401 &&
                !retried) {
                invalidateAgentSession();
                return send(true);
            }
            throw errorFromResponseBody(response.status, errorData);
        }
        const json = await response.json();
        if (!json.data && json.data !== null) {
            throw new Error("No data returned from middleware");
        }
        return json;
    }
    return send(false);
}
// Start server
async function main() {
    const server = createNubisMcpServer(getResultsFromMiddleware);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Nubis MCP Server running on stdio");
}
main().catch((error) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error("Fatal error in main():", errorMessage);
    process.exit(1);
});
