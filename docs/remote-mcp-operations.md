# Browser-connected MCP: implementation and release gates

## Current state

Implemented locally: a maintained OAuth broker (`oidc-provider` 9.12.2), encrypted
PostgreSQL persistence, workspace consent, refresh, revocation, and the remote MCP
resource. Nubis consent and connection-management UI live in the paired PMTool
branch `feat/oauth-consent` at `/tmp/pmtool-oauth-consent`.

No remote MCP deployment has been published. The human enabled Supabase OAuth;
an approved, isolated confidential test client is registered. The human confirmed
real-account sign-in, workspace access and revocation through the localhost broker.
See `real-account-local-test.md`. Automated browser tests also use fixture identity
with real PostgreSQL, Chromium and the official MCP SDK; those fixtures do not
prove production RLS. A non-root Docker image now builds and passes local health/
disabled-feature smoke checks, excluding private configuration and local harnesses.

## Authorization boundary

- Supabase remains the human login provider. A dedicated confidential upstream
  OAuth client gives the broker its own Supabase session; it never copies the
  SPA's refresh token or races the browser's token rotation.
- The broker owns the exact interaction, authorization code, grant, and refresh
  family. Each consent creates a new grant, even for the same human/client.
- The connection's user/client/workspace binding is immutable, including in SQL.
- MCP clients receive opaque broker tokens, never upstream Supabase credentials.
- All upstream credentials and protocol artifacts are AES-256-GCM encrypted in
  the dedicated broker database, with record-bound authenticated context.
- Current human membership and `check_permission` task actions are checked on
  every resource request and again before executing a tool. User-scoped RLS is
  retained. No service-role task writes or authorization fallback.
- Legacy handlers additionally validate task/parent/comment references against
  the selected workspace, because the upstream user may belong to several.
- Read/write consent caps access; a reduced role can reduce it further. No remote
  deletion, billing, agent minting, or membership-administration tools.
- Revoking one grant invalidates that grant's artifacts without changing another
  connection. Leaving a workspace denies further tool calls.
- Upstream refresh is serialized with a PostgreSQL advisory lock. A durable
  pending marker prevents reusing an old refresh token after a crash or uncertain
  refresh result; that connection must sign in again instead.
- The broker uses PKCE S256, exact redirect matching, resource audiences, signed
  cookies, CSRF tokens, fixed discovery URLs, Host/Origin validation, and rate limits.
  Resource tokens last five minutes; connection grants last at most 30 days.

The earlier direct Supabase token-hook design is superseded. No custom Supabase
JWT role, `pm_mcp_grants` table, or Supabase token hook is needed for this broker.
`remote-auth.ts` retains the earlier verifier and its tests, but production
configuration now wires the broker, not that verifier.

## Human-controlled setup before enabling

1. Review the authorization change and record the user-owned ADR.
2. Provision a **dedicated broker PostgreSQL database**, not the Nubis production
   Supabase database. Human applies
   `docs/database/20260914090000_oauth_broker.sql` with a server-only database login.
3. Configure Supabase OAuth Server with a confidential upstream client using
   `token_endpoint_auth_method=client_secret_post` (not the default Basic). Its exact
   redirect URI is `https://<broker-host>/connect/callback/upstream`; scopes are
   `openid`. Point the authorization page at the deployed Nubis `/oauth/consent`
   route. Review the shared Supabase Site URL before changing it; do not break
   existing login redirects. Configure asymmetric signing/OIDC as required by
   Supabase. Verify refresh issuance and existing RLS with a real test account.
4. Supply server secrets via the deployment secret store (never client env/code):
   `NUBIS_BROKER_DATABASE_URL`, `NUBIS_BROKER_ENCRYPTION_KEY` (32 random bytes,
   base64), `NUBIS_BROKER_COOKIE_KEYS` (JSON array of persistent strong keys),
   `NUBIS_BROKER_JWKS` (private RSA signing JWK set),
   `NUBIS_UPSTREAM_OAUTH_CLIENT_ID`, `NUBIS_UPSTREAM_OAUTH_CLIENT_SECRET`.
5. Supply server configuration: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `NUBIS_MCP_RESOURCE_URL=https://<broker-host>/mcp`,
   `NUBIS_APP_ORIGIN=https://<nubis-app-host>`. The broker issuer is
   `https://<broker-host>/oauth`.
6. Supply **public** SPA configuration: `VITE_NUBIS_MCP_BROKER_URL` (origin only)
   and `VITE_NUBIS_OAUTH_BROKER_CLIENT_ID` (the public upstream client ID).
   For OAuth-only identity, set server `NUBIS_UPSTREAM_AUTH_MODE=oauth2` and
   SPA `VITE_NUBIS_UPSTREAM_OAUTH_SCOPE=profile`. Use the native Supabase issuer
   URL rather than a custom domain whose discovery advertises another issuer.
   Dedicated tests should set `NUBIS_REMOTE_MCP_ONLY=true` (no service-role key)
   and `NUBIS_MCP_READ_ONLY=true`. See `hosted-test-setup.md` for the consent
   routing option and same-site hosting requirement.
7. Complete security/release review, including encryption-key rotation/recovery,
   registration abuse limits, and authorization adapter failure/restart behavior.
   User decision: browser MCP has no usage quota. Task role permissions and
   security/anti-abuse rate limits remain enforced. Legacy API-key usage counters
   are unchanged and are not applied to browser MCP connections.
8. Verify the full hosted flow with at least two target MCP clients and real
   Supabase membership removal/revocation. Only then set
   `NUBIS_REMOTE_MCP_ENABLED=true` and authorize production deployment.

Do not enable partially configured infrastructure. Missing broker settings/schema
fail closed; disabled is the default. Existing stdio/API-key clients remain.

## Local validation

Default suites (no production access):

```sh
npm run mcp:test
npm --prefix server test
```

Broker + real React browser flow (isolated PostgreSQL and the paired UI checkout):

```sh
NUBIS_BROKER_TEST_DATABASE_URL='postgresql://<local-user>:<local-password>@127.0.0.1:<port>/<test-db>' \
NUBIS_PMTOOL_TEST_ROOT=/tmp/pmtool-oauth-consent \
npm --prefix server run test:broker
```

The broker test refuses a non-loopback database. Apply the broker SQL to that test
DB first. Chromium defaults to `/usr/bin/chromium`; override with
`NUBIS_TEST_CHROMIUM`. Use Node 22 LTS or another supported LTS runtime.
Screenshot proof is local at `/tmp/nubis-oauth-consent-proof.png`, not committed.

Covered: rendered sign-in/consent/approval, concurrent A/B connections for the same
user/client with reverse code exchange, foreign workspace rejection, CSRF, denied
consent, wrong PKCE, code and refresh-token replay, refresh isolation, read-only role, encrypted
storage, Settings revocation, removal of membership, immutable SQL binding,
serialized upstream refresh, interrupted-refresh denial, atomic code consumption,
and vault persistence across store instances.

Not covered by fixture success: real Supabase OAuth configuration/token exchange,
real production role/RLS policies, live deployment, or the full repository's UI
acceptance/design-baseline process. Do not claim those as passed.

## Runtime/build

Middleware now requires Node 22+; the published stdio client's Node 18+ contract
is unchanged (built stdio handshake also passed on Node 18.20.8). Build context must include root `src/` and `server/`; middleware
runs from `server/dist/server/index.js`. Install both manifests before building.
The dedicated broker database and credential encryption key must be backed up
separately. Rotating the vault key currently requires an explicit re-encryption
procedure or reconnecting affected grants; do not silently replace it.
