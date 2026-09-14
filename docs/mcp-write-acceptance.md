# Local MCP write acceptance

## Result

Passed with the official MCP SDK client over HTTP, shared registry, existing
middleware create/update/move handlers, real PostgREST 13.0.7 and PostgreSQL 17.
No mocked task handlers or service-role writes. Authentication is a fixture in
this suite; OAuth issuance and real-user sign-in are covered separately.

Covered:
- Create tasks in an exact workflow column, assign a member, create subtasks.
- Update title/description, move to done, move back, explicitly clear assignment.
- Title-only changes retain project, column, parent and GitHub references.
- Reject foreign project/column/parent/assignee/task IDs, even when the user
  belongs to both workspaces; reject caller-supplied connection identity.
- Reject read-only MCP writes and current RLS create/update permission denial.
- Rejected operations leave no partial tasks or modified foreign-workspace rows.
- Database consistency trigger rejects contradictory board/project relationships.
- Every observed write uses the user's JWT, never the service-role key.
- Comments/replies and sequential context appends; reject foreign-task or foreign-
  workspace parent comments and writes after update permission is removed.
- Four context writers forced to read the same snapshot retain all four fragments
  exactly once. The old handler lost three fragments. The fix uses PostgreSQL
  `xmin` compare-and-set with at most eight confirmed-conflict retries; uncertain
  writes are not retried. Large notes pass, and private context never enters URL
  filters. Live user-role PostgREST supports version reads/filters (read-only check).
- Concurrent title/move updates preserve both changes. Competing explicit-column
  moves leave a coherent project/board/column/status tuple.
- Four simultaneous creates forced to observe the same max task number all succeed
  with distinct numbers. The test requires an actual unique-constraint conflict.

The test reproduced a real bug before the fix: the in-process dispatcher passed
own properties with `undefined`, whereas HTTP JSON omits those fields. Legacy
patch handlers interpreted omitted project/parent/GitHub fields as explicit
clears. `remote-dispatch.ts` now removes undefined top-level fields while retaining
explicit nulls. A no-Docker regression also runs in `remote-mcp.test.ts`.

## Scope and remaining gates

`docs/database/mcp-write-fixture.sql` contains minimal relationships and explicit
permission RLS, NOT a production RLS snapshot. The actual task consistency function
and composite constraints were applied unchanged from PMTool's
`docs/database/20260913090000_atomic_project_workflows.sql`, through the section
before `CREATE FUNCTION public.pm_mutate_workflow`.

This does not alone prove production policies, legacy API-key/agent HTTP
integration, concurrent deletes, or bulk creation. Separate source-backed policy
and built legacy HTTP contract tests now pass; evidence and limits are recorded
in `production-mcp-release.md`. Hosted read-only acceptance is recorded separately
in `hosted-acceptance-status.md`.

Run the source-backed role tests with a localhost database named
`nubis_mcp_policy_acceptance`, existing local test roles (authenticated, anon and
service_role), and Node 22:

```sh
cd server
NUBIS_POLICY_TEST_DATABASE_URL=postgresql://postgres:local-fixture-only@127.0.0.1:32768/nubis_mcp_policy_acceptance \
NUBIS_PMTOOL_TEST_ROOT=/tmp/pmtool-oauth-consent npm run test:policies
```

The test installs only into that isolated database. It extracts unchanged helper
and policy definitions from the three named PMTool migrations, omits teardown
statements when installing into a fresh database, and retains fixtures. Never
apply `mcp-policy-fixture.sql` to Supabase or the hosted broker database.
Single-task creation now retries only the confirmed task-number unique violation,
up to eight attempts; ambiguous network errors and other failures are not retried.
This fixes a reproduced concurrent-create failure without a production migration.
No production SQL was applied; the real-account localhost test remains read-only.

Read-only inspection of project qhrhgklpeblwwtygvpew confirmed the production
`pm_tasks_project_id_task_number_key` unique index already exists. It also confirmed
that `pm_workflow_task_consistency()` and `pm_mutate_workflow(uuid,text,jsonb)` are
initially absent. The human subsequently applied the atomic migration; both
functions, the enabled consistency trigger, both constraints and permissions were
verified through Supabase MCP. A later audit found one task among 2,115 with a
valid same-project column but no parent board. The guarded human repair is in the
paired frontend worktree at `docs/database/20260914093000_repair_task_workflow_parent.sql`;
it also aligns legacy inbox status to in-progress and validates both constraints.
The repair and an idempotent re-run passed locally, not in production.
`pm_tasks_write_guard` also enforces assignee/manager rules not modeled by this
minimal fixture.

## Current local environment

- PostgreSQL container: `nubis-oauth-local-pg`, localhost port 32768.
- Separate database: `nubis_mcp_write_acceptance` (not the broker/session DB).
- PostgREST container: `nubis-write-postgrest`, localhost port 32769.
- Fixture records are retained. Each test run creates unique workspace IDs.

```sh
cd /tmp/nubis-mcp-workflows
NUBIS_WRITE_TEST_DATABASE_URL=postgresql://postgres:local-fixture-only@127.0.0.1:32768/nubis_mcp_write_acceptance \
NUBIS_WRITE_TEST_POSTGREST_URL=http://127.0.0.1:32769 \
npm --prefix server run test:writes
```

Use Node 22. The runner rejects non-loopback endpoints and any other database
name. It starts and closes its own localhost HTTP servers. It never deletes
fixture records or stops the real-account test.

For a fresh environment, create that separate local database, apply the fixture
SQL once, then the unchanged consistency section noted above, and apply the local
`mcp-write-fixture-comments.sql` and `mcp-write-fixture-uniqueness.sql` fixtures. Start
`postgrest/postgrest:v13.0.7` bound only to localhost, with these test-only values:
`PGRST_DB_URI=postgresql://mcp_fixture_authenticator:local-write-fixture-only@<local-container-ip>:5432/nubis_mcp_write_acceptance`,
`PGRST_DB_ANON_ROLE=anon`, `PGRST_DB_SCHEMAS=public`,
`PGRST_JWT_SECRET=local-write-fixture-jwt-secret-at-least-32-characters`.
Do not run this setup against Supabase or a populated non-fixture database.
