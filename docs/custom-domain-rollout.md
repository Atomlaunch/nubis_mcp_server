# Browser MCP custom domain — live and write-verified

Final acceptance: human completed fresh OAuth for `nubis-live` at
`https://mcp.nubis.app/mcp`; 13 tools loaded. Read task 93, appended marker
`MCP-CUSTOM-DOMAIN-20260914`, then independently read full details confirming
persistence, both previous context markers, unchanged title/description/project
and Done routing. No additional tasks created. Git/npm publication remains pending.

## Latest fix

- User experienced `/workspaces` after sign-in. Reproduced on the deployed app
  using Chromium with intercepted fixture Auth responses and no selected workspace.
- `useProjectInitialization` classified `/oauth/consent` and `/mcp/connect` as
  ordinary app routes. Added both exact paths to `src/lib/authPaths.ts` in the
  frontend worktree. Four new regressions failed before the fix; all 30 targeted
  Auth/consent tests passed afterward.
- Allowlisted export `/tmp/nubis-hosted-custom-domain-v2/artifact-manifest.json`;
  deployment `1b4eca17-58b9-4cae-90dd-c6006e31598e` reached SUCCESS.
- Same deployed Chromium scenario now retains `/oauth/consent` and its heading.
  Real SDK registration/PKCE → Supabase authorization → hosted login also passes.
- Upstream OAuth callback was initially missing from the OAuth app. User corrected
  it; independent probe now returns 302 to expected upstream consent, not 400.
- Fresh `nubis-live` authorization and authenticated custom-domain write read-back
  passed, as recorded above. Earlier attempts are historical diagnostics.


User approved `https://mcp.nubis.app/mcp`. Legacy `mcp-server.nubis.app` is untouched.

## Completed

- Added Railway custom domain `790ae421-e743-4f57-b783-e4cadc9894aa` to broker
  service `f37b7b88-f9f9-4b95-8c98-70867b93af74`, port 8080, project
  `163ef1e8-da2f-4974-a29d-eeb5c1d6ea25`, environment
  `337f46e7-1971-450b-9539-bfe5ec22efb8`.
- Prepared allowlisted source + rebuilt same-origin consent UI at
  `/tmp/nubis-hosted-custom-domain-v1/artifact-manifest.json`. Build succeeded;
  not deployed. Public browser config uses `https://mcp.nubis.app` and upstream
  scope `profile`. No secret variables or environment files copied into export.
- Cutover deployment `c00d8698-5977-4a2a-bfd2-9a0d7b8d90d4` reached SUCCESS.
  Runtime app origin and resource now use `https://mcp.nubis.app`.
- User confirmed DNS and Supabase Auth configuration. Public DNS returns both
  required records, Railway ownership is verified, and certificate status is VALID.
- HTTPS health, OAuth discovery (new issuer/resource and write scopes), and MCP
  401 challenge passed using the public DNS address with curl `--resolve` and
  normal TLS validation. No TLS verification bypass.
- Local OS/Node resolver still returns ENOTFOUND for the new domain; installing
  `nubis-live` failed at connectivity validation. Wait for local negative DNS
  caching to expire, then install and complete fresh human OAuth. Final authenticated
  custom-domain write acceptance has not yet run. Previous-origin writes passed.

## Human configuration (confirmed complete)

No Cloudflare tool or environment credential was available in this session.

Cloudflare zone `nubis.app`:
- CNAME `mcp` → `gp3rzor4.up.railway.app`, DNS only.
- TXT `_railway-verify.mcp` →
  `railway-verify=f2fc29534b4548e8cb929a2e52bf88c0dd49ef4cdf081d60a1776e561646c924`.

Supabase Auth (preserve all existing entries and the shared Site URL):
- Add exact allowed origin `https://mcp.nubis.app` and redirect entry
  `https://mcp.nubis.app/**`.
- OAuth client `42493f05-d40b-475f-bdca-dd8b541cb11a`: add exact redirect URI
  `https://mcp.nubis.app/connect/callback/upstream`.

## Cutover checklist (steps 1–3 complete; steps 4–5 remaining)

1. Verify Railway ownership, DNS and valid HTTPS certificate.
2. Set `NUBIS_APP_ORIGIN=https://mcp.nubis.app` and
   `NUBIS_MCP_RESOURCE_URL=https://mcp.nubis.app/mcp` without auto-deploy, then
   upload the new allowlisted artifact. Preserve signing/encryption/cookie keys,
   database configuration and `NUBIS_UPSTREAM_CONSENT_ORIGIN=https://go.nubis.app`.
3. Observe the exact new deployment SUCCESS; verify discovery issuer/resource,
   unauthenticated challenge and consent entry through the new domain.
4. Fresh human OAuth approval on the custom URL, then verify writes using existing
   acceptance task 93 (`a44e7076-1257-4944-8ec4-0a8b40749d26`). Do not silently
   broaden or migrate old grants. Old issuer tokens will require reauthorization.
5. Update current status docs. Git/npm reconciliation is still outstanding.

Rollback, if required, is to the previous artifact and original URL variables;
keep domain/DNS entries and data rather than deleting them.
