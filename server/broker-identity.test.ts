import assert from "node:assert/strict";
import { supabaseBrokerIdentity } from "./broker-identity.js";

const issuer = "https://identity.fixture.test/auth/v1";
const clientId = "11111111-1111-4111-8111-111111111111";
const clientSecret = "fixture-secret-with-hyphens";
const userId = "22222222-2222-4222-8222-222222222222";
const originalFetch = globalThis.fetch;
let exchanges = 0;
let consentLocation =
  "https://existing-ui.fixture.test/oauth/consent?authorization_id=fixture-authorization-request-123";
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.href === `${issuer}/.well-known/openid-configuration`)
    return Response.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
    });
  if (
    url.origin === new URL(issuer).origin &&
    url.pathname === "/auth/v1/oauth/authorize"
  ) {
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: consentLocation },
    });
  }
  if (url.href === `${issuer}/oauth/token`) {
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.has("Authorization"),
      false,
      "Supabase must receive supported form-post client authentication",
    );
    const body = new URLSearchParams(String(init?.body));
    assert.equal(
      body.get("client_id"),
      clientId,
      "UUID is decoded by form parsing, not treated as escaped Basic text",
    );
    assert.equal(body.get("client_secret"), clientSecret);
    assert.ok(
      ["authorization_code", "refresh_token"].includes(body.get("grant_type")!),
    );
    exchanges++;
    return Response.json({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      token_type: "bearer",
      expires_in: 3600,
      scope: "profile",
    });
  }
  if (url.href === `${issuer}/user`) {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer fixture-access",
    );
    return Response.json({
      id: userId,
      aud: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    });
  }
  throw new Error(`Unexpected test request to ${url.origin}${url.pathname}`);
};
try {
  const identity = await supabaseBrokerIdentity({
    issuer,
    supabaseUrl: "https://identity.fixture.test",
    anonKey: "fixture-anon",
    clientId,
    clientSecret,
    useOidc: false,
    consentUiOrigin: "https://test-ui.fixture.test",
    expectedConsentOrigin: "https://existing-ui.fixture.test",
  });
  const attempt = await identity.start(
    "http://127.0.0.1:5180/connect/callback/upstream",
  );
  const authorization = new URL(attempt.url);
  assert.equal(authorization.searchParams.get("scope"), "profile");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    await identity.authorizationPage!(attempt),
    "https://test-ui.fixture.test/oauth/consent?authorization_id=fixture-authorization-request-123",
  );
  await assert.rejects(
    identity.authorizationPage!({
      ...attempt,
      url: "https://attacker.example/authorize",
    }),
    /endpoint/,
  );
  consentLocation =
    "https://attacker.example/oauth/consent?authorization_id=fixture-authorization-request-123";
  await assert.rejects(identity.authorizationPage!(attempt), /destination/);
  consentLocation =
    "https://existing-ui.fixture.test/untrusted?authorization_id=fixture-authorization-request-123";
  await assert.rejects(identity.authorizationPage!(attempt), /destination/);
  const session = await identity.finish(
    new URL(
      `http://127.0.0.1:5180/connect/callback/upstream?code=fixture-code&state=${attempt.state}`,
    ),
    attempt,
  );
  assert.equal(
    session.userId,
    userId,
    "identity is verified with the real getUser request path, not decoded token claims",
  );
  assert.equal((await identity.refresh(session)).userId, userId);
  assert.equal(
    exchanges,
    2,
    "both initial exchange and refresh use the compatible method",
  );
  console.log(
    "Supabase broker identity client-auth, PKCE, user verification, and refresh regression passed",
  );
} finally {
  globalThis.fetch = originalFetch;
}
