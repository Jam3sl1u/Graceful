# Test Results — Issue #33: RLS bypass tests for Sprint 0–1 tables

## Verdict: PASS

## What was independently verified

### 1. Static checks (re-run from scratch, not trusted from changes.md)
- `bun install` — clean, no changes.
- `bun run typecheck` (`tsc --noEmit`) — **passes**, 0 errors.
- `bun run lint` (`eslint .`) — **passes**, 0 errors/warnings.
- `bun run test` (`jest`, unit suite) — **passes**: 11 suites / 112 tests, 0
  failures. Confirms the RLS changes do not touch/break the unit suite.
- `bun run test:rls` (`jest --config jest.config.integration.ts`) with
  `SUPABASE_TEST_URL`/`SUPABASE_TEST_ANON_KEY`/`SUPABASE_TEST_SERVICE_ROLE_KEY`/
  `SUPABASE_JWT_SECRET` all unset — **8 suites skipped, 227 tests skipped, 0
  failed**. Confirms the `describe.skip` guard works and `cross-tenant-bypass.test.ts`
  is correctly picked up by the `jest.config.integration.ts` glob (matches the
  coder's reported numbers exactly).

All of the above match changes.md's claims exactly.

### 2. Code review against spec (`.pipeline/spec.md`)
Read `tests/integration/rls/setup.ts`, `helpers.ts`,
`tables/cross-tenant-bypass.test.ts`, `supabase/seed-rls-test.sql`, the diff to
`rls.test.ts`, and `supabase/README.md` line-by-line against the spec.

- `IDS` extensions match the spec's exact UUID table verbatim (all 15 new/promoted
  ids, all in the right sub-objects).
- `seedViaServiceClient()` Church-B inserts match the spec's per-table column
  sets exactly, including the new `event_attendees` A+B block placed after
  `events`/`users`.
- `assertUpdateNoOp` / `assertDeleteNoOp` in `helpers.ts` implement the spec's
  pseudocode verbatim: before/after service-client reads, error from the
  attacker's write is ignored (tolerates both silent no-op and hard privilege
  error), per-patch-key equality assertion; delete checks exactly-one-row-survives.
- `cross-tenant-bypass.test.ts` has a `describe` block for all 19 Sprint 0–1
  tables (`church_groups` through `audit_logs`), each running
  SELECT/INSERT/UPDATE/DELETE from `memberA` against Church B's seeded rows. The
  four role-gated tables (`setlists`, `invitations`, `conflicts`, `audit_logs`)
  additionally repeat INSERT/UPDATE/DELETE as `adminA`, matching the spec's
  requirement. Every target id / INSERT row / UPDATE patch matches the spec's
  table verbatim (checked all 19 rows individually).
- `supabase/seed-rls-test.sql` mirrors `seedViaServiceClient()` row-for-row with
  identical UUIDs and columns (diffed both side by side).
- `rls.test.ts`'s three inline-literal → `IDS.*` promotions are pure refactors
  (same UUID values), confirmed via diff.
- `supabase/README.md` additions accurately describe both the new canonical test
  file and the CI "skip ≠ block" limitation, matching the spec's open-question
  resolution.

### 3. Live RLS verification (the part changes.md flagged it could not do)
The coder's own changes.md said `bun run test:rls` could not be run against a
live Supabase instance in their environment, and asked the Tester to do so. I
built an independent (non-Supabase-CLI) verification harness rather than
skipping this:

- Started a bare `postgres:16-alpine` Docker container.
- Created `anon`/`authenticated`/`service_role` roles and a minimal `auth.jwt()`
  stub reading the `request.jwt.claims` GUC (the same mechanism Supabase's
  Postgres image provides), matching what `auth_church_group_id()` /
  `auth_user_role()` in the migrations rely on.
- Applied all 13 files under `supabase/migrations/` in lexicographic order —
  **all applied with zero errors**, producing the full 19-table schema with RLS
  enabled and all policies created.
- Granted default `SELECT/INSERT/UPDATE/DELETE` to `authenticated`/`anon` (as
  Supabase's project bootstrap does), then re-applied the `audit_logs`
  UPDATE/DELETE `REVOKE` from the Cluster 6 migration.
- Loaded `supabase/seed-rls-test.sql` as-is against this schema — **loaded with
  zero errors** (19 `INSERT` statements + 1 `TRUNCATE`, all columns/FKs valid).
  This independently confirms the new Church-B rows and the new
  `event_attendees` block are schema-correct, not just structurally mirrored
  between the TS and SQL seed paths.
- Set `request.jwt.claims` to memberA's/adminA's Church-A claims under `SET ROLE
  authenticated`, then ran the actual SQL each verb in the bypass matrix issues,
  against every one of the 19 tables' Church-B target row (using the spec's
  exact target ids / INSERT rows / UPDATE patches):
  - **SELECT**: 0 rows returned for all 19 tables (`church_groups` included).
  - **INSERT**: `new row violates row-level security policy` for all 19 tables
    (including `church_groups`, which has no INSERT policy at all).
  - **UPDATE**: `UPDATE 0` (silent no-op, row unchanged) for all tables except
    `audit_logs`.
  - **DELETE**: `DELETE 0` (silent no-op, row still present) for all tables
    except `audit_logs`.
  - **audit_logs UPDATE/DELETE**: `permission denied for table audit_logs` (hard
    privilege error from the `REVOKE`), exactly the edge case the coder
    flagged — confirms `assertUpdateNoOp`/`assertDeleteNoOp`'s error-tolerant
    design is necessary and correct here.
  - Repeated INSERT/UPDATE/DELETE as `adminA` for `setlists`, `invitations`,
    `conflicts`, `audit_logs` — all identically denied/no-op, confirming
    privilege escalation doesn't bypass tenant isolation.
- **Sanity check (to rule out a false-pass from a broken harness)**: confirmed
  memberA CAN `SELECT` all Church-A `users` rows and CAN `UPDATE` their own
  Church-A `availability` row (`UPDATE 1`, value changed) under the exact same
  role/JWT setup. This proves the harness genuinely distinguishes tenant
  boundaries rather than blocking all access indiscriminately.
- Removed the Docker container after verification.

This directly exercises the same RLS policies, the same seed data, and the same
per-table target/INSERT/UPDATE values the Jest matrix uses (via raw SQL rather
than through `supabase-js`/PostgREST, since the full Supabase CLI/GoTrue/PostgREST
stack wasn't available in this environment) — every one of the 19 tables × 4
verbs behaved exactly as `cross-tenant-bypass.test.ts` asserts.

## Known residual gap (not a blocker, inherited from spec's own open question)
- I did not run `bun run test:rls` through the actual `supabase-js` HTTP path
  (needs a full `supabase start`/PostgREST/GoTrue stack or a linked test
  project, neither available here). The raw-SQL verification above exercises
  the identical RLS policies and seed data, so this is a strong proxy, but it
  does not prove the `mintJwt`/`getUserClient`/`getServiceClient` plumbing in
  `client.ts`/`jwt.ts` (unchanged by this PR, reused as-is) works correctly
  end-to-end over HTTP. That plumbing predates this issue and is out of this
  issue's scope.
- The CI `rls-integration` job is still not a required/blocking status check —
  per the spec's OPEN QUESTIONS #1, this is an explicitly out-of-scope
  repo-settings action for a human, correctly called out in `supabase/README.md`.

## Final numbers
- `bun run typecheck`: pass
- `bun run lint`: pass
- `bun run test`: 11 suites / 112 tests pass
- `bun run test:rls` (no env vars): 8 suites / 227 tests skipped, 0 failed
- Live raw-SQL RLS matrix (19 tables × 4 verbs, + adminA repeats for 4 role-gated
  tables): all behaved exactly as `cross-tenant-bypass.test.ts` asserts — no
  cross-tenant leak or mutation found.

No failures found. Recommend proceeding to Reviewer.
