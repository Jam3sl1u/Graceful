# Changes — Issue #33: RLS bypass tests for Sprint 0–1 tables

## Open question resolution (applied, per human decision)

The planner flagged that making the `rls-integration` CI job a **required/blocking**
status check is a GitHub repo-settings action (branch protection + the four
`SUPABASE_TEST_*`/`SUPABASE_JWT_SECRET` secrets), not a code change, and is out of
scope for the Coder. Resolution applied: implement the test coverage now (this PR),
leave `.github/workflows/ci.yml` and branch protection untouched, and call out in the
PR description that turning `rls-integration` into a required check needs a separate
branch-protection/repo-secrets change outside this PR's scope. `supabase/README.md`
now documents this explicitly (see below).

## Files changed

### `tests/integration/rls/setup.ts`
- Extended the `IDS` object with Church-B ids for every table that previously only had
  Church-A seed rows, plus new sub-objects: `memberInstruments`, `songDocuments`,
  `notificationPreferences`, `eventAttendees`.
- Promoted three previously-inline UUID literals into `IDS` constants:
  `memberInstruments.memberA` (`...8004-000000000010`), `notificationPreferences.memberA`
  (`...800e-000000000001`), `songDocuments.A` (`...8011-000000000001`) — these ids are
  unchanged, only their source of truth moved into `setup.ts`.
- `seedViaServiceClient()`: added Church-B rows for `member_profiles`,
  `member_instruments`, `invitations`, `conflicts`, `availability`, `notifications`,
  `notification_preferences`, `google_calendar_tokens`, `audit_logs`, `song_documents`,
  and a brand-new `event_attendees` insert block (Church A + Church B rows — this table
  had no seed rows before). All inserts mirror the exact column sets specified in the
  spec.

### `supabase/seed-rls-test.sql`
- Mirrored the identical Church-B rows (and the two `event_attendees` rows) as SQL
  `INSERT` statements in the matching sections, using the same UUIDs and columns as
  `seedViaServiceClient()`. `event_attendees` was already listed in the file's
  `TRUNCATE ... CASCADE` header but had no insert section before this change.

### `tests/integration/rls/helpers.ts`
- Added `assertUpdateNoOp(userClient, serviceClient, table, id, patch)`: reads the row
  via the service client before the attacker's UPDATE, runs the UPDATE (ignoring any
  error — a hard privilege error is an acceptable block), re-reads via the service
  client, and asserts every patched column is unchanged from the BEFORE value.
- Added `assertDeleteNoOp(userClient, serviceClient, table, id)`: runs the attacker's
  DELETE (ignoring any error), then asserts the row still exists via the service
  client.
- Both reuse the existing `assertInsertDenied`/`assertSelectBlocked` — no duplication.

### `tests/integration/rls/tables/cross-tenant-bypass.test.ts` (new)
- The canonical AC-1 matrix: one `describe` block per all 19 Sprint 0–1 tables
  (`church_groups`, `users`, `member_profiles`, `instruments`, `member_instruments`,
  `service_weeks`, `setlists`, `setlist_songs`, `events`, `invitations`,
  `event_attendees`, `conflicts`, `songs`, `song_documents`, `availability`,
  `notification_preferences`, `notifications`, `google_calendar_tokens`,
  `audit_logs`), each running SELECT/INSERT/UPDATE/DELETE from a Church-A attacker
  (`memberA`) against Church-B's seeded rows.
- For the four role-gated tables (`setlists`, `invitations`, `conflicts`,
  `audit_logs`), the INSERT/UPDATE/DELETE attempts are additionally run as `adminA`
  to prove even a privileged Church-A user cannot cross tenants.
- SELECT filters use `church_group_id: IDS.churches.B` for Tier-1 tables and the
  specific Church-B row `id` for Tier-2/Tier-3 tables (`member_profiles`,
  `member_instruments`, `setlist_songs`, `event_attendees`,
  `notification_preferences`, `google_calendar_tokens`), per the spec's table-by-table
  breakdown.
- Follows the existing skip guard (`!rlsTestsEnabled || !process.env.SUPABASE_TEST_URL`
  → `describe.skip`) and `beforeAll` seeding pattern from `cross-tenant.test.ts`, so the
  suite is a no-op under `bun run test` (unit) and in CI without the four Supabase test
  secrets.

### `tests/integration/rls/rls.test.ts`
- Updated three previously-inline UUID literals (`NP_ID`, `MI_A`, `SD_A`) to reference
  the newly-promoted `IDS.notificationPreferences.memberA`, `IDS.memberInstruments.memberA`,
  and `IDS.songDocuments.A` constants respectively. No behavior change — same UUIDs,
  now sourced from `setup.ts` instead of being duplicated inline.

### `supabase/README.md`
- Added a sentence under "RLS Integration Tests (#33)" noting that
  `tables/cross-tenant-bypass.test.ts` is the canonical four-verb cross-tenant matrix
  and must be extended (with a new `describe` block + Church-B seed row) whenever a new
  table is added in later sprints.
- Extended the existing "In CI" note to spell out the open-question resolution: the
  `rls-integration` job is *skipped* (not failed) when `SUPABASE_TEST_URL` is unset,
  which GitHub treats as passing and does not block merge; making it a required status
  check plus provisioning the four CI secrets is a repo-settings change outside this
  PR's scope, tracked as a follow-up.

## No changes needed (confirmed, not touched)
- `jest.config.integration.ts` — `testMatch` glob already picks up the new file
  automatically.
- `.github/workflows/ci.yml` — `rls-integration` job already runs `bun run test:rls`
  after applying migrations; no branch-protection/required-check change made (see open
  question resolution above).
- `tests/integration/rls/client.ts`, `jwt.ts` — reused as-is.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` (unit) — 11 suites / 112 tests pass, unaffected by the RLS changes.
- `bun run test:rls` — without live Supabase env vars, all 8 integration suites
  (including the new `cross-tenant-bypass.test.ts`) report skipped (227 tests skipped,
  0 failed), confirming the skip guard works and the new file is correctly picked up by
  the glob. Could not run against a live seeded Supabase instance in this environment;
  the Tester should run `bun run test:rls` against a real Supabase test project (or
  local `supabase start`) to exercise the full 19-table × 4-verb matrix.

## What the Tester should focus on
- Running `bun run test:rls` against an actual seeded Supabase instance is the only way
  to validate the core of this issue — the matrix logic cannot be verified via
  typecheck/lint/unit tests alone.
- `audit_logs` UPDATE/DELETE are REVOKEd at the DB level (hard privilege error, not a
  silent no-op) — `assertUpdateNoOp`/`assertDeleteNoOp` must tolerate that error path
  while still confirming the row is unchanged/present.
- `church_groups` has no INSERT/UPDATE/DELETE policy at all — verify all writes are
  denied by RLS default and that SELECT is filtered by `id` (there's no
  `church_group_id` self-reference column).
- `notification_preferences` INSERT test uses `{ user_id: IDS.users.memberB }`, which
  collides with the seeded Church-B row on `user_id` — this INSERT will likely fail on
  a unique constraint (`23505`) rather than a pure RLS denial (`42501`).
  `assertInsertDenied` only checks that an error is present (any error), so this still
  passes, but it does not, by itself, prove RLS is the cause for that specific
  assertion — this is an accepted spec choice (the per-table INSERT row for
  `notification_preferences` was specified explicitly by the spec), not an oversight.
- Verify no Church-B data was actually mutated in a real run — the bypass tests are
  designed to be no-ops (INSERT attempts fail and insert nothing; UPDATE/DELETE
  attempts are filtered to 0 rows), so `beforeAll`'s idempotent
  delete-then-insert reseed should leave the fixture stable across repeated runs.
