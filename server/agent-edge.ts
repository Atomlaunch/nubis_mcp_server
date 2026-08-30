/**
 * Calls PMTool Edge functions for agent-principal auth.
 * Never looks up agent secrets in api_keys. Never uses service role for agent writes.
 * `agent-token` is password grant (not generateLink / magic-link). Mint is `invite-agent`.
 */

export type EdgeCallResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

export function edgeNotWiredBody(functionName: string): Record<string, unknown> {
  return {
    error: "not_wired",
    code: "EDGE_NOT_WIRED",
    function: functionName,
    message: `PMTool Edge function ${functionName} is not deployed. Agent principal calls cannot proceed. Refusing to fall back to api_keys + service role.`,
  };
}

export function agentModeConfigBody(detail: string): Record<string, unknown> {
  return {
    error: "agent_mode_not_configured",
    code: "AGENT_MODE_CONFIG",
    message: `${detail} Refusing to fall back to api_keys + service role.`,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { error: typeof value === "string" ? value : "Unexpected Edge response" };
}

export async function callEdgeFunction(options: {
  supabaseUrl: string;
  anonKey: string;
  functionName: string;
  accessToken?: string;
  body: unknown;
  fetchImpl?: typeof fetch;
}): Promise<EdgeCallResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return {
      ok: false,
      status: 501,
      body: agentModeConfigBody("fetch is not available in this runtime."),
    };
  }

  const base = options.supabaseUrl.replace(/\/$/, "");
  const url = `${base}/functions/v1/${options.functionName}`;
  const bearer = options.accessToken || options.anonKey;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        apikey: options.anonKey,
      },
      body: JSON.stringify(options.body ?? {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 501,
      body: agentModeConfigBody(`Could not reach Edge function ${options.functionName}: ${message}`),
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (response.status === 404) {
    return { ok: false, status: 501, body: edgeNotWiredBody(options.functionName) };
  }

  const data = asObject(parsed);
  if (!response.ok) {
    if (!data.code) {
      data.code = response.status === 501 ? "EDGE_NOT_WIRED" : "EDGE_ERROR";
    }
    if (!data.function) data.function = options.functionName;
    return { ok: false, status: response.status, body: data };
  }

  return { ok: true, status: response.status, data };
}

export function sessionFromAgentTokenPayload(
  payload: Record<string, unknown>
): { access_token: string; expires_in: number; refresh_token?: string; user: { id?: string } } | null {
  const access_token =
    (typeof payload.access_token === "string" && payload.access_token) ||
    (typeof payload.accessToken === "string" && payload.accessToken) ||
    "";
  if (!access_token) return null;
  const expires_in =
    typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  const refresh_token =
    typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
  const userObj =
    payload.user && typeof payload.user === "object"
      ? (payload.user as { id?: unknown })
      : {};
  const userId = typeof userObj.id === "string" ? userObj.id : undefined;
  return {
    access_token,
    expires_in,
    refresh_token,
    user: { id: userId },
  };
}
