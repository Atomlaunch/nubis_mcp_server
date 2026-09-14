# Production middleware release — 2026-09-14

The user explicitly requested live MCP changes for a meeting. The middleware
release is deployed; the complete browser-write rollout is not finished.

## Live middleware

- URL: https://mcp-server.nubis.app
- Railway project: 78ae9eef-ea3f-47c5-9ee7-60df64d34b3b
- Environment: e3f7796c-7ab1-4d20-9b1c-a00528081f46
- Service: 47c54237-b43c-489e-84aa-b671fc9d0dc2
- Deployment: 90023f61-f039-4fd0-9ad0-22d4b8feb7ff — observed SUCCESS.
- Previous deployment: 8cf233b6-969e-479b-ae0b-b0add718e67c.
- Exact allowlisted artifact: /tmp/nubis-production-export-v1/artifact-manifest.json.
- Existing Nixpacks build/start commands and credentials were preserved.
  Added NIXPACKS_NODE_VERSION=22 and /health readiness with a 180-second timeout.
- No consent UI, Dockerfile, environment files, private keys, local harnesses,
  test files, or Git metadata were included in this production upload.

Contains workflow-aware routes, omission-preserving updates, bounded task-number
and context-append concurrency fixes, and live legacy agent revocation checks.
The latter was reproduced against the real built HTTP middleware: a valid Auth
JWT kept reading after simulated key revocation (200 instead of 403). The fix
checks the existing agent_jwt_allowed RPC with the user's JWT before any legacy
agent access; false results and lookup errors fail closed. Workspace API keys
and trusted browser OAuth requests retain their separate authentication paths.

## Validation

- Middleware test suite and built legacy HTTP contract suite passed.
- Built stdio handshake and shared-registry tests passed.
- Actual MCP → handlers → PostgREST/PostgreSQL write tests passed locally,
  including concurrent creates, context appends and title/move updates.
- Source-backed task/comment policy tests passed for owner, admin, co-owner,
  member, team/assignment isolation, forged authors, revoked-agent writes,
  permission loss and membership loss.
- Read-only comparison confirmed all 13 tested permission-function bodies and
  security-definer flags match live definitions after whitespace normalization.
  Supporting fixture tables are minimal, not a complete production schema.
- Live authenticated role has EXECUTE on agent_jwt_allowed.
- After deployment: /health returned 200; new /get_projects and /get_task_boards
  correctly returned 401 without credentials. The existing configured legacy
  MCP client successfully read projects; its paid-plan usage stayed unlimited.
- Separate authenticated browser MCP project and workflow reads still pass.
- git diff --check passed. No production task writes or SQL mutations were run.

## Boundaries and remaining work

- Browser URL: https://broker-test.up.railway.app/mcp. Its independent read-only
  deployment remains 230b54c9-60b2-4ab7-9435-db85438b740d. Existing grants were
  not upgraded or replaced. Browser writes remain disabled.
- Source/GitHub and npm publication remain pending. This is an exact artifact
  deployment, not a reviewed Git release. Existing npm clients do not acquire
  new tool schemas merely because the middleware was deployed.
- The service still follows main on GitHub. Reconcile/publish reviewed source
  before another main deployment; otherwise that deployment can replace this
  uploaded snapshot with older code.
- Another distinct client's authenticated interoperability and controlled live
  write acceptance remain unproven. Legacy upstream-auth tests use explicit
  contract doubles; database-policy tests are a separate layer.
- The human-only historical task repair remains pending. Task 92 still has a
  missing board, and both composite workflow constraints remain NOT VALID.
  This existing task can fail consistency checks until repaired. New/updated
  relationships are still checked by PostgreSQL's NOT VALID constraints.
- Human repair file:
  /tmp/pmtool-oauth-consent/docs/database/20260914093000_repair_task_workflow_parent.sql
  It changes the task's legacy Inbox status to In Progress to match its column.
- No production frontend, Supabase Site URL, broker consent, or browser grant
  permissions were changed during this release.
