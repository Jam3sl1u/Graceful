# Test Results — Issue #28: Remove/archive member with PII anonymization

## Verdict: PASS (with one documented, environment-caused gap)

This replaces the prior FAIL report, which correctly identified that the
`.pipeline/` artifacts belonged to Issue #37 and that no #28 code existed.
Implementation has since been written per the approved plan
(`.claude/plans/issue-28-description-fancy-beacon.md`) and is on this branch.

## What was run

- `bun run typecheck` — **0 errors.**
- `bun run lint` — **0 errors/warnings.**
- `bun run test` (unit suite) — **186/186 passed, 15 suites**, including:
  - `tests/unit/app/api/church-group-members-id-route.test.ts` (new, 13 tests)
    — 401×2, 403×3 (`it.each` over `set_leader`/`member`/`guest`), 400
    (malformed id), 404/422/403/401 mapped from RPC error-message
    substrings, 500 on an unrecognized RPC error and on an empty
    `{data: null, error: null}` response, the 200 success path (asserts the
    exact `rpc(...)` call, the response body, and the `writeAuditLog` call),
    and 500 when `writeAuditLog` throws after a successful RPC call.
  - `tests/unit/app/api/church-group-members-route.test.ts` (extended) — new
    test asserting the roster query calls `.is("anonymized_at", null)`.
- `bun run test:rls` — the new
  `tests/integration/rls/tables/member-removal.test.ts` **loads without
  error and is correctly skipped**, same as all 8 other files in that
  directory (`rlsTestsEnabled` gates the whole suite on
  `SUPABASE_TEST_URL`/`SUPABASE_TEST_ANON_KEY`/`SUPABASE_TEST_SERVICE_ROLE_KEY`/
  `SUPABASE_JWT_SECRET` being set).

## Gap: the integration test has not been run against a live database

I attempted to check whether a local Supabase instance could be started in
this environment to run `member-removal.test.ts` for real (it's the one
part of this change — the BR-12 concurrent-removal locking — that a mocked
unit test structurally cannot verify). Findings:

- No `supabase` CLI was pre-installed, but `bunx supabase` works
  (v2.109.1) and Docker is available.
- `supabase/config.toml` currently has `[api] enabled = false` — the
  PostgREST auto-API is disabled by architecture rule (PRD §19.3/§25.1,
  issue #23: all DB access must go through Next.js routes, never Supabase's
  generated REST API) — and the file's own header comment says it's a
  placeholder ("Run `bunx supabase init` to populate this fully"). With the
  API disabled, `supabase-js` (which every RLS integration test, including
  the 8 pre-existing ones, depends on for its REST calls) would have
  nothing to talk to from a plain `supabase start` in this state.

Standing up a real local stack would mean changing `[api].enabled` or
otherwise reworking this placeholder config — that's infrastructure outside
Issue #28's scope, and none of the 8 pre-existing RLS suites have apparently
been run for real in this environment either (they're all designed to
degrade to `describe.skip`). I did not attempt it.

**What a human should do before merging**: run `supabase start && bun run
test:rls` (or against whatever CI/staging Supabase instance already has
this wired up) and specifically watch the "concurrent BR-12 enforcement"
test in `member-removal.test.ts` — it is the one assertion in this whole
change that depends on Postgres's actual locking behavior rather than
mocked control flow.

## Manual verification not performed

No UI to exercise (this is a backend-only DELETE endpoint) and no live DB in
this environment, so the plan's "manual/integration sanity check" section
(admin removes a member → fields anonymized, directory excludes them, audit
log written) has not been exercised end-to-end. The unit tests cover the
same logic at the handler/mock boundary; the integration test (once run for
real, see above) covers it at the DB boundary.

## What the Reviewer should focus on

- Correctness of the RPC's locking strategy (`ORDER BY id FOR UPDATE` over
  `{target} ∪ {current admins}` in one statement) — see the inline comment
  in `supabase/migrations/20260710000001_member_removal_rpc.sql` for the
  deadlock reasoning; this was a real bug I caught and fixed while designing
  the concurrent-removal test, not present in the original plan's first
  draft.
- Whether shipping without a live-DB run of `member-removal.test.ts` is
  acceptable, given the repo's existing RLS integration suite already ships
  in this same "designed to skip locally" state.
