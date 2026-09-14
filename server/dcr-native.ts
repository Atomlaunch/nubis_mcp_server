/** Cursor MCP DCR omits application_type and sends native + loopback + https URIs. */
export const CURSOR_MCP_REDIRECT_URIS = [
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "http://localhost:8787/callback",
] as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isNativeOrLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:")
      return LOOPBACK.has(url.hostname);
    return url.protocol !== "";
  } catch {
    return false;
  }
}

export function applyNativeDcrDefaults(
  metadata: {
    application_type?: string;
    redirect_uris?: unknown;
  },
  requestedType?: unknown,
): void {
  // oidc-provider defaults omitted application_type to "web" before this runs.
  if (typeof requestedType === "string" && requestedType.length > 0) return;
  if (
    Array.isArray(metadata.redirect_uris) &&
    metadata.redirect_uris.some(
      (uri) => typeof uri === "string" && isNativeOrLoopbackRedirect(uri),
    )
  )
    metadata.application_type = "native";
}

export const nativeDcrClientMetadata = {
  properties: ["application_type"],
  validator(
    ctx: { oidc?: { body?: { application_type?: unknown } } } | undefined,
    key: string,
    _value: unknown,
    metadata: { application_type?: string; redirect_uris?: unknown },
  ) {
    if (key === "application_type")
      applyNativeDcrDefaults(metadata, ctx?.oidc?.body?.application_type);
  },
};
