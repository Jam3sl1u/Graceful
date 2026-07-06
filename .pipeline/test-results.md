# Test Results — Issue #24: Church group creation (`PUT /api/church-group`)

## Summary: PASS

All independently re-run checks pass. The coder's claims in `.pipeline/changes.md`
were verified against the actual code, not just trusted, and the unit test suite
was expanded with 4 additional cases the coder's original suite did not cover.

## Commands re-run (from a clean `bun install`, not trusting the coder's report)

- `bun install` — no changes needed, lockfile in sync.
- `bun run typecheck` (`tsc --noEmit`) — **PASS**, no errors.
- `bun run lint` (`eslint .`) — **PASS**, no errors.
- `bun run test` (`jest`) — **PASS**, 5 suites / 29 tests (was 25; +4 added by tester).
- `bun run check:service-role` — **PASS**: "OK: no service-role key references
  found outside comments in app/ or lib/."
- `bunx prettier --check` on all touched TS files (route, schema, types,
  test) — **PASS**. Note: the migration `.sql` file cannot be checked by
  Prettier — running it directly against the file errors with "No parser
  could be inferred for file ... .sql", and running Prettier against the
  whole repo silently skips `.sql` files entirely. This is a pre-existing
  project limitation (no SQL Prettier plugin configured), not a gap
  introduced by this change; the coder's claim of "prettier passes on all
  touched files" should be read as "all touched files Prettier supports."

## Code review against spec.md (manual verification, not just re-stating changes.md)

Verified line-by-line against the spec:

- `supabase/migrations/20260706000001_church_group_create_rpc.sql`:
  - `generate_invite_code()` — correct alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`,
    excludes 0/O/1/I/L), 8-char length, retry-until-unique loop against
    `church_groups.invite_code`, `SECURITY DEFINER`/`SET search_path = ''`,
    not granted to `authenticated`. Matches spec exactly.
  - `create_church_group(...)` — checks `auth.jwt() ->> 'sub'` null →
    `RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001'`; existing
    `users` row check → `USER_ALREADY_IN_GROUP`; inserts `church_groups` then
    `users` (role `admin`) then exactly the 8 named instruments in the
    spec's exact order via a hardcoded array, `is_default = true`,
    `created_by = NULL`; no "Other" row (9th row) inserted. `GRANT EXECUTE
    ... TO authenticated` present. Commented DOWN section present.
  - Cross-checked column names/types against the actual table definitions in
    `supabase/migrations/20260702000001_cluster_1_organization.sql` and
    `20260702000002_cluster_2_instruments.sql` — `church_groups`
    (name/denomination/timezone/logo_url/invite_code), `users`
    (clerk_id/church_group_id/role/name/email), `instruments`
    (church_group_id/name/is_default/created_by) all match the INSERT
    statements in the RPC. No column-name mismatches found.
  - Style matches the existing `SECURITY DEFINER` / `SET search_path = ''`
    convention in `20260704000001_rls_policies.sql`.
  - Not executed against a live Postgres/Supabase instance — no local
    Supabase CLI/DB available in this environment, consistent with the
    coder's own flag in changes.md. This is a real coverage gap for DB-level
    behavior (exact instrument count/order under a real engine, invite-code
    uniqueness under concurrency, atomic rollback on partial failure) — but
    it is appropriately deferred to `tests/integration/rls/` per spec, and
    explicitly out of scope for this pass.

- `schemas/church-group.ts` — matches spec's example exactly:
  `name` required (1-100, trimmed), `timezone` optional with
  `.default("America/Chicago")` and an `isValidIanaTimezone` refine (no
  hardcoded list, uses `Intl.DateTimeFormat` try/catch), `denomination`/
  `logoUrl` optional with correct max lengths. Old unused
  `churchGroupSchema`/`ChurchGroupInput` removed as instructed.

- `app/api/church-group/route.ts` — matches spec step-by-step: `auth()` →
  401 if no `clerkId`; `getToken({ template: "supabase" })` → 401 if null;
  `req.json().catch(() => null)` + `safeParse` → 400 `VALIDATION_FAILED`;
  `currentUser()` → `deriveCreatorName` fallback chain
  (fullName → "first last" → username → email local-part → "Admin", truncated
  to 100 chars) exactly as specified; `creatorEmail` from
  `primaryEmailAddress` or `null`; `supabase.rpc("create_church_group", {...})`
  with the exact param names/mapping from the spec; error-message
  substring-matching for `USER_ALREADY_IN_GROUP` (409) and `UNAUTHENTICATED`
  (401), else 500; success → `ok(data, 201)`. Whole handler wrapped in
  try/catch → 500 fallback. Does not call `requireAuth`, consistent with the
  Background rationale. `GET` unchanged (`notImplemented`).

- `lib/supabase/types.ts` — `ChurchGroupsRow` and `church_groups` table entry
  added mirroring the `users` entry style; `Functions.create_church_group`
  typed with the exact `Args`/`Returns` shape from the spec. `bun run
  typecheck` confirms `supabase.rpc("create_church_group", ...)` in the route
  compiles without `any`/casts.

## Unit tests — independently expanded, not just re-run

The coder's original 8 tests in
`tests/unit/app/api/church-group-route.test.ts` (201 happy path, 400 missing
name, 400 invalid timezone, 401 no Clerk userId, 401 no JWT, 409
USER_ALREADY_IN_GROUP, 500 generic RPC error, "Admin" name fallback) were
reviewed and all still pass.

I added 4 more cases the spec calls out as edge cases but the coder's suite
did not exercise, per this stage's mandate to independently verify rather
than trust the coder's test list:

1. **Missing `timezone` defaults to `America/Chicago`** and is forwarded to
   the RPC as `p_timezone` (spec: "Missing `timezone` → allowed, defaults to
   America/Chicago" — previously asserted only indirectly, never with
   `timezone` actually omitted from the request body).
2. **Provided `denomination`/`logoUrl` are passed through unchanged** to
   `p_denomination`/`p_logo_url` (previously only the `null`/omitted case was
   asserted; the non-omitted pass-through path was untested).
3. **Non-JSON / empty body** (`req.json()` rejects with a `SyntaxError`,
   simulating an unparseable/empty body) → 400 `VALIDATION_FAILED`, `rpc`
   never called (spec edge case: "Body is not JSON / empty body → 400").
   The coder's tests only exercised `safeParse` failure on a *valid* JSON
   object missing `name`; the `.catch(() => null)` path itself was untested.
4. **Unexpected thrown error** (`currentUser()` rejects) → outer try/catch
   → 500 `INTERNAL`, `rpc` never called. This is the "at least one failure
   case" required for this stage and exercises a code path (the outer
   try/catch) that no existing test touched — all prior 500 tests only
   covered the RPC returning a Supabase `error` object, not a thrown
   exception.

All 4 new tests pass against the current implementation; no code changes
were required to make them pass.

Final test count: **29/29 passing** (5 suites), `jest` exit code 0.

## Verdict

No discrepancies found between `.pipeline/changes.md`'s claims and the
actual code/behavior. Implementation matches `.pipeline/spec.md` in full,
including the settled instrument-count decision (exactly 8, no "Other" row)
and the PUT-creates (not PUT-updates) divergence from PRD §22.1. Recommend
proceeding to review.

Remaining known gaps (pre-existing/spec-acknowledged, not regressions from
this change):
- No live DB execution of the migration (no local Supabase instance
  available in this environment).
- DB-level integration coverage (instrument count/order under a real engine,
  admin role assignment, invite-code collision handling) deferred to
  `tests/integration/rls/`, per spec.

**Result: PASS. No blocking issues found. Ready for Reviewer.**
