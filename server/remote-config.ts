import { Pool } from "pg";
import { BrokerStore } from "./broker-store.js";
import { supabaseBrokerIdentity } from "./broker-identity.js";
import { createOAuthBroker } from "./oauth-broker.js";
import { validatePublicUrl, type RemoteMcpConfig } from "./remote-mcp.js";

/** Production is opt-in; no ephemeral keys, in-memory storage, or service-role fallback. */
export function remoteMcpConfig(
  env: NodeJS.ProcessEnv,
  execute: RemoteMcpConfig["execute"],
): ReturnType<typeof createOAuthBroker> | null {
  if (env.NUBIS_REMOTE_MCP_ENABLED !== "true") return null;
  const required = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "NUBIS_MCP_RESOURCE_URL",
    "NUBIS_APP_ORIGIN",
    "NUBIS_BROKER_DATABASE_URL",
    "NUBIS_BROKER_ENCRYPTION_KEY",
    "NUBIS_BROKER_COOKIE_KEYS",
    "NUBIS_BROKER_JWKS",
    "NUBIS_UPSTREAM_OAUTH_CLIENT_ID",
    "NUBIS_UPSTREAM_OAUTH_CLIENT_SECRET",
  ];
  if (required.some((key) => !env[key]))
    throw new Error(`Remote MCP requires ${required.join(", ")}`);
  const resource = validatePublicUrl(env.NUBIS_MCP_RESOURCE_URL!);
  const app = validatePublicUrl(env.NUBIS_APP_ORIGIN!);
  if (app.href !== `${app.origin}/`)
    throw new Error("NUBIS_APP_ORIGIN must be an origin");
  const consentOrigin = env.NUBIS_UPSTREAM_CONSENT_ORIGIN
    ? validatePublicUrl(env.NUBIS_UPSTREAM_CONSENT_ORIGIN)
    : undefined;
  if (consentOrigin && consentOrigin.href !== `${consentOrigin.origin}/`)
    throw new Error("NUBIS_UPSTREAM_CONSENT_ORIGIN must be an origin");
  const database = new URL(env.NUBIS_BROKER_DATABASE_URL!);
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hostname.endsWith("supabase.co") ||
    database.hostname.endsWith("supabase.com")
  ) {
    throw new Error(
      "Use a dedicated broker PostgreSQL database, not the Nubis Supabase database",
    );
  }
  const cookieKeys = JSON.parse(env.NUBIS_BROKER_COOKIE_KEYS!);
  if (
    !Array.isArray(cookieKeys) ||
    !cookieKeys.length ||
    cookieKeys.some((key) => typeof key !== "string" || key.length < 32)
  )
    throw new Error("Configure strong persistent broker cookie keys");
  const jwks = JSON.parse(env.NUBIS_BROKER_JWKS!);
  if (
    !Array.isArray(jwks.keys) ||
    !jwks.keys.some((key: any) => key.kty === "RSA" && key.d)
  )
    throw new Error("Configure a private RSA broker signing key");
  const authMode = env.NUBIS_UPSTREAM_AUTH_MODE ?? "oidc";
  if (!["oidc", "oauth2"].includes(authMode))
    throw new Error("NUBIS_UPSTREAM_AUTH_MODE must be oidc or oauth2");
  const pool = new Pool({
    connectionString: env.NUBIS_BROKER_DATABASE_URL,
    max: 10,
    statement_timeout: 10000,
  });
  const store = new BrokerStore(
    pool,
    Buffer.from(env.NUBIS_BROKER_ENCRYPTION_KEY!, "base64"),
  );
  return (async () => {
    try {
      await store.ready();
      const identity = await supabaseBrokerIdentity({
        issuer: `${env.SUPABASE_URL!.replace(/\/$/, "")}/auth/v1`,
        supabaseUrl: env.SUPABASE_URL!,
        anonKey: env.SUPABASE_ANON_KEY!,
        clientId: env.NUBIS_UPSTREAM_OAUTH_CLIENT_ID!,
        clientSecret: env.NUBIS_UPSTREAM_OAUTH_CLIENT_SECRET!,
        useOidc: authMode === "oidc",
        consentUiOrigin: consentOrigin ? app.origin : undefined,
        expectedConsentOrigin: consentOrigin?.origin,
      });
      if (env.NUBIS_MCP_READ_ONLY === "true") {
        const workspaces = identity.workspaces.bind(identity);
        const access = identity.access?.bind(identity);
        identity.workspaces = async (session) =>
          (await workspaces(session)).map((workspace) => ({
            ...workspace,
            actions: workspace.actions.filter((action) => action === "read"),
          }));
        if (access)
          identity.access = async (session, workspaceId) => {
            const workspace = await access(session, workspaceId);
            return workspace
              ? {
                  ...workspace,
                  actions: workspace.actions.filter(
                    (action) => action === "read",
                  ),
                }
              : null;
          };
      }
      return await createOAuthBroker({
        issuer: `${resource.origin}/oauth`,
        resource: resource.href,
        appOrigin: app.origin,
        managementOrigin: env.NUBIS_MCP_MANAGEMENT_ORIGIN,
        store,
        identity,
        cookieKeys,
        jwks,
        execute,
      });
    } catch (error) {
      await pool.end();
      throw error;
    }
  })();
}
