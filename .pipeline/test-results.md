# Test Results — Issue #24 (Implement church group creation)

## Overall: PASS

All coder claims in `.pipeline/changes.md` were independently re-verified. Two
new unit test files were added by the Tester (not present before); all other
checks were re-run from scratch rather than trusted from the changes.md report.

## Checks performed

1. **`bun install`** — clean, no changes needed.

2. **`bun run lint` (`eslint .`)** — PASS, exit 0, no errors. Re-run again after
   adding the new test files — still clean.

3. **`bun run typecheck` (`tsc --noEmit`)** — PASS, exit 0, no errors. Confirms
   `lib/supabase/types.ts`'s new `ChurchGroupsRow`/`InstrumentsRow`/`Functions`
   entries and the route's `.rpc("create_church_group", ...)` call type-check
   correctly.

4. **`bun run check:service-role`** — PASS
   (`OK: no service-role key references found outside comments in app/ or lib/.`).
   Confirmed no service-role key is referenced anywhere in the new route/schema
   code, per the spec's Key architectural constraint.

5. **Manual review of the migration** (`supabase/migrations/20260705000001_church_group_create_fn.sql`)
   against the spec — PASS. Verified:
   - `SECURITY DEFINER`, `SET search_path = ''`, all tables schema-qualified
     `public.*`.
   - `v_clerk_id := auth.jwt() ->> 'sub'` with `GR000` on null.
   - Already-a-member guard raises `GR001` before any writes.
   - Invite code: 8 chars, built one-`gen_random_bytes(1)`-byte-per-char from
     the exact unambiguous alphabet specified in the spec, inserted inside a
     `begin … exception when unique_violation … continue` retry loop.
   - `users` insert captures `id` via `returning id into v_user_id`, used as
     `created_by` for all 9 `instruments` rows with the exact 9 names from the
     spec/PRD §11, `is_default = true`.
   - `grant execute ... to authenticated;` present; commented `drop function`
     DOWN block present.
   - This matches the spec's Postgres SQL requirements exactly — this part is
     out of scope for Jest unit tests per the spec's tester notes and is
     intended for the live-DB RLS integration suite (`bun run test:rls`), which
     was not run here (no live DB available in this environment) — consistent
     with the spec explicitly carving this out.

6. **New unit tests added by Tester** (not present in the coder's diff):
   - `tests/unit/app/api/church-group-route.test.ts` — mocks
     `@clerk/nextjs/server` (`auth`, `currentUser`) and
     `@/lib/supabase/client` (`getSupabaseClient` → `{ rpc }` mock), following
     the `admin-only-route.test.ts` / `lookup-user.test.ts` patterns named in
     the spec. Covers:
     - Happy path: valid body → 201, RPC called with correctly-mapped
       snake_case params, response body echoes RPC's returned row.
     - Omitted `timezone` → defaults to `America/Chicago` (passed through to
       RPC).
     - Omitted `denomination`/`logo_url` → `null` passed to RPC (not
       `undefined`).
     - Missing `name` → 400 `VALIDATION_FAILED`, RPC never called.
     - Blank/whitespace-only `name` → 400 `VALIDATION_FAILED`.
     - Non-IANA `timezone` (`"Not/AZone"`) → 400 `VALIDATION_FAILED`.
     - Malformed JSON body (simulated `req.json()` throwing) → 400
       `VALIDATION_FAILED`, confirms the route's `.catch(() => null)` swallows
       the throw rather than propagating it.
     - No Clerk session (`clerkId` null) → 401 `UNAUTHENTICATED`; asserted
       `req.json()` is never called (fails fast before parsing).
     - Missing Supabase JWT (`getToken` resolves `null`) → 401
       `UNAUTHENTICATED`, RPC never called.
     - RPC error `{ code: "GR001" }` → 409 `CONFLICT` **(failure case)**.
     - RPC error with any other code → 500 `INTERNAL` **(failure case)**.
     - Name derivation edge cases: falls back to `username` when
       first/last name absent (and email falls back to `null` when no
       Clerk email present); falls back to literal `"Admin"` when no name
       info exists at all.
     - `GET /api/church-group` still returns the untouched 501
       `NOT_IMPLEMENTED` stub.
   - `tests/unit/schemas/church-group.test.ts` — direct schema tests for
     `createChurchGroupSchema`: happy path (trims all string fields), default
     timezone, optional fields left `undefined` when omitted, missing name,
     blank name, name > 100 chars, non-IANA timezone, invalid `logo_url`,
     denomination > 100 chars **(failure cases)**.

7. **`bun run test` (full suite, after adding the above)** — PASS:
   `Test Suites: 6 passed, 6 total`, `Tests: 40 passed, 40 total`. The 4
   pre-existing suites (17 tests) are unaffected/unchanged, confirming the new
   code and tests introduce no regressions.

8. **`bun run format:check`** — same 10 pre-existing failures as before this
   change (`README.md`, `supabase/README.md`,
   `tests/integration/rls/**`), none introduced by this issue's code or by the
   Tester's new test files (both new test files were run through
   `prettier --write` and are clean; confirmed by re-running `format:check`
   after — file count of failures dropped from 11 to 10, i.e. only the
   Tester's own file was flagged then fixed). This matches the coder's claim
   that these are pre-existing, unrelated failures.

## Notes for Reviewer

- The live-DB RLS integration suite (`bun run test:rls`) was not run — no
  Supabase instance is available in this test environment, and the spec
  explicitly scopes SQL-level verification (invite-code collision retry,
  atomicity, `GR000`/`GR001`) to that suite rather than Jest unit tests. The
  migration SQL was instead manually reviewed line-by-line against the spec
  (see item 5 above) and matches exactly.
- No issues found in the coder's implementation. All spec requirements
  (routes, schema, types, migration, docs) were verified either by automated
  test or manual code review against the spec text.

**Result: PASS. No blocking issues found. Ready for Reviewer.**
