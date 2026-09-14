import * as oidc from "openid-client";
import { createClient } from "@supabase/supabase-js";
import type { UpstreamSession } from "./broker-store.js";

export type LoginAttempt = {
  url: string;
  state: string;
  verifier: string;
  nonce: string;
};
export type WorkspaceAccess = { id: string; name: string; actions: string[] };
export interface BrokerIdentity {
  start(callback: string): Promise<LoginAttempt>;
  authorizationPage?(attempt: LoginAttempt): Promise<string>;
  finish(url: URL, attempt: LoginAttempt): Promise<UpstreamSession>;
  refresh(session: UpstreamSession): Promise<UpstreamSession>;
  workspaces(session: UpstreamSession): Promise<WorkspaceAccess[]>;
  access?(
    session: UpstreamSession,
    workspaceId: string,
  ): Promise<WorkspaceAccess | null>;
  userForToken(token: string): Promise<string>;
}

export async function supabaseBrokerIdentity(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  supabaseUrl: string;
  anonKey: string;
  /** OAuth-only mode verifies identity with Supabase getUser, not an ID token. */
  useOidc?: boolean;
  consentUiOrigin?: string;
  expectedConsentOrigin?: string;
}): Promise<BrokerIdentity> {
  // A dedicated confidential upstream client owns a separate Supabase session.
  // Never copy the SPA's refresh token into the broker (that would race rotation).
  const config = await oidc.discovery(
    new URL(options.issuer),
    options.clientId,
    options.clientSecret,
    // Supabase does not decode form-escaped Basic credentials (including UUID hyphens).
    // Use its supported POST method rather than overriding the library's RFC encoding.
    oidc.ClientSecretPost(options.clientSecret),
  );
  const db = (token: string) =>
    createClient(options.supabaseUrl, options.anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  async function userForToken(token: string): Promise<string> {
    const { data, error } = await db(token).auth.getUser(token);
    if (error || !data.user || data.user.app_metadata?.kind === "agent")
      throw new Error("Human sign-in required");
    return data.user.id;
  }
  async function session(
    tokens: oidc.TokenEndpointResponse,
    previous?: UpstreamSession,
  ): Promise<UpstreamSession> {
    if (
      !tokens.access_token ||
      !(tokens.refresh_token || previous?.refreshToken) ||
      !tokens.expires_in
    )
      throw new Error("Upstream did not issue a renewable session");
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previous!.refreshToken,
      expiresAt: Date.now() / 1000 + tokens.expires_in,
      userId: await userForToken(tokens.access_token),
    };
  }
  if (
    Boolean(options.consentUiOrigin) !== Boolean(options.expectedConsentOrigin)
  )
    throw new Error("Both consent origins must be configured");
  return {
    userForToken,
    authorizationPage: options.consentUiOrigin
      ? async (attempt) => {
          const target = new URL(attempt.url);
          const expected = new URL(
            config.serverMetadata().authorization_endpoint!,
          );
          if (
            target.origin !== expected.origin ||
            target.pathname !== expected.pathname
          )
            throw new Error("Unexpected authorization endpoint");
          const response = await fetch(target, {
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          });
          const location = response.headers.get("location");
          if (![302, 303].includes(response.status) || !location)
            throw new Error("Unable to start upstream authorization");
          const redirect = new URL(location);
          const id = redirect.searchParams.get("authorization_id");
          if (
            redirect.origin !== options.expectedConsentOrigin ||
            redirect.pathname !== "/oauth/consent" ||
            !id ||
            !/^[A-Za-z0-9_-]{20,128}$/.test(id)
          )
            throw new Error("Unexpected upstream consent destination");
          return `${options.consentUiOrigin}/oauth/consent?authorization_id=${encodeURIComponent(id)}`;
        }
      : undefined,
    async start(callback) {
      const state = oidc.randomState(),
        verifier = oidc.randomPKCECodeVerifier(),
        nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback,
        scope: options.useOidc === false ? "profile" : "openid",
        state,
        ...(options.useOidc === false ? {} : { nonce }),
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      return { url: url.href, state, verifier, nonce };
    },
    async finish(url, attempt) {
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        expectedState: attempt.state,
        expectedNonce: options.useOidc === false ? undefined : attempt.nonce,
        pkceCodeVerifier: attempt.verifier,
        idTokenExpected: options.useOidc !== false,
      });
      const upstream = await session(tokens);
      if (options.useOidc !== false && tokens.claims()?.sub !== upstream.userId)
        throw new Error("Upstream token identities do not match");
      return upstream;
    },
    async refresh(previous) {
      return session(
        await oidc.refreshTokenGrant(config, previous.refreshToken),
        previous,
      );
    },
    async access(upstream, workspaceId) {
      const client = db(upstream.accessToken);
      const { data: member, error } = await client
        .from("pm_members")
        .select("id")
        .eq("project_id", workspaceId)
        .eq("user_id", upstream.userId)
        .eq("member_kind", "human")
        .maybeSingle();
      if (error) throw new Error("Unable to check membership");
      if (!member) return null;
      const actions = await Promise.all(
        ["read", "create", "update"].map(async (action) => {
          const { data: can, error: permissionError } = await client.rpc(
            "check_permission",
            {
              p_project_id: workspaceId,
              p_user_id: upstream.userId,
              p_resource: "tasks",
              p_action: action,
            },
          );
          if (permissionError)
            throw new Error("Unable to check task permissions");
          return can === true ? action : null;
        }),
      );
      return {
        id: workspaceId,
        name: "",
        actions: actions.filter((action): action is string => action !== null),
      };
    },
    async workspaces(upstream) {
      const userId = await userForToken(upstream.accessToken);
      if (userId !== upstream.userId)
        throw new Error("Upstream identity changed");
      const client = db(upstream.accessToken);
      const { data, error } = await client
        .from("pm_members")
        .select("project_id,member_kind,workspace:pm_projects!inner(id,name)")
        .eq("user_id", userId)
        .eq("member_kind", "human");
      if (error) throw new Error("Unable to check workspace membership");
      return Promise.all(
        (data ?? []).map(async (member: any) => {
          const workspace = Array.isArray(member.workspace)
            ? member.workspace[0]
            : member.workspace;
          const allowed = await Promise.all(
            ["read", "create", "update"].map(async (action) => {
              const { data: can, error: permissionError } = await client.rpc(
                "check_permission",
                {
                  p_project_id: member.project_id,
                  p_user_id: userId,
                  p_resource: "tasks",
                  p_action: action,
                },
              );
              if (permissionError)
                throw new Error("Unable to check task permissions");
              return can === true ? action : null;
            }),
          );
          return {
            id: member.project_id,
            name: workspace.name,
            actions: allowed.filter(
              (action): action is string => action !== null,
            ),
          };
        }),
      );
    },
  };
}
