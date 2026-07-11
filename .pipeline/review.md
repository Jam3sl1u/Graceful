# Review — Issue #34: Implement availability set/get

VERDICT: SHIP

## Verification performed
- Read spec, changes, and test-results; ran `git diff main...HEAD` on source (excluding `.pipeline/`).
- Ran independently: `bun run typecheck` (clean), `bun run lint` (clean), `bun run test` (233 passed / 17 suites).
- Confirmed out-of-scope stubs untouched: `app/api/availability/[date]/route.ts` (DELETE #35) and `app/api/availability/team/route.ts` (GET #36) still return `notImplemented`.

## Assessment against spec
- `lib/supabase/types.ts`: `AvailabilityRow` + `availability` table registration match the specced shape verbatim (Insert makes `id`/`created_at`/`is_available` optional).
- `schemas/availability.ts`: `DATE_RE`, `getAvailabilityQuerySchema`, `setAvailabilityEntrySchema` (superRefine enforcing exactly-one-form, real-calendar-date via UTC round-trip, `startDate <= endDate`), and `setAvailabilitySchema` (`.min(1).max(400)`) all implemented as specced. `note` normalization mirrors profile.ts bio pattern.
- `app/api/availability/handler.ts`: auth/JWT flow, try/catch mapping, and DB-default Insert cast copied faithfully from profile handler. GET role-gates cross-user reads via `requireRole(["admin","set_leader"])`; PUT is caller-scoped only. Range expansion is UTC-day-stepped (DST-safe). 366 cap enforced before the DB client is built. Dedup uses `Map<date,...>` last-entry-wins, producing a single upsert with `onConflict: "user_id,date"`.
- `app/api/availability/route.ts`: thin GET/PUT delegators, matches profile route.

## Correctness spot-checks (traced by hand)
- `2026-02-30` → round-trips to `2026-03-02`, rejected (400). Confirmed.
- Empty/whitespace `note` → null; `isAvailable` omitted → true. Confirmed in code and tests.
- Malformed `user_id` → 400 before role gate; other-user by member → 403; own-id any role → 200.
- 366-day boundary (2024 leap year) allowed; 367 rejected with DB client never constructed.

## Tests
Tester added `tests/unit/app/api/availability-route.test.ts` (27 tests). Coverage is meaningful, not superficial: it asserts actual upsert payload shape (user_id/church_group_id/date/is_available/note), dedup last-wins values, expansion ordering across a month boundary, the exact 366 row count, onConflict options, and that the DB client is skipped on the cap-exceeded and no-JWT paths. Matches the profile/audit-log mock pattern.

## Minor notes (non-blocking)
- The 366 cap is applied to the raw cumulative expansion before dedup, so heavily-overlapping entries totaling >366 raw dates would 400 even if the deduped set is smaller. This is conservative and consistent with the spec's "guard against accidental years-long blocks" intent; acceptable.
- `format:check` reports pre-existing Prettier warnings across many files (including the new test file); not part of the pipeline gate and pre-existing on main. Not blocking.

No security, correctness, or performance issues found. Ships.
