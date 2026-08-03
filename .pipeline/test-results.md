# Test Results — Issue #70: Notification preferences API (BR-14 minimum-channel guard)

This overwrites the stale `test-results.md` for issue #65 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: ALL PASS

## What was independently verified

- `bun run lint` — clean, no warnings or errors.
- `bun run typecheck` — clean (`tsc --noEmit`), no errors.
- `bun run test` (full suite, before adding any tester tests) — 82 suites /
  1062 tests passed, confirming the Coder's reported numbers in
  `.pipeline/changes.md`.
- Read `lib/supabase/types.ts`, `schemas/notifications.ts`,
  `app/api/notifications/preferences/handler.ts`, and `route.ts` in full and
  diffed them against every requirement in `.pipeline/spec.md` (column list,
  defaults, BR-14 guard placement before the write, partial-merge semantics,
  `chat_preference` exclusion, `user_id` always from `ctx.userId`, error
  codes/status codes). All match the spec exactly.

## Additional tests written this stage

Added `tests/unit/app/api/notification-preferences-route-tester-supplement.test.ts`
(7 new tests) to independently probe gaps in the Coder's own
`notification-preferences-route.test.ts` fixture, which couples the
pre-write select and post-write upsert to the same `error`/`data` fields and
so never actually isolates the upsert's own failure branch, never checks the
`reminderHoursBefore` integer boundaries, never exercises `route.ts`'s `GET`/
`PUT` exports directly (only the underlying `handler.ts` functions), and
never explicitly asserts the SELECT column list excludes `chat_preference`.

Covered:
1. **Upsert-specific 500** — pre-write select succeeds, but the upsert call
   itself returns a Supabase error → 500 `INTERNAL` (previously only the
   pre-write select's error path was isolated from the upsert's).
2. **Upsert returns no error but no row** → 500 `INTERNAL` (the `!data`
   half of the handler's `error || !data` check on the upsert result).
3. **`reminderHoursBefore` boundary values** (`1` and `168`, both spec-valid
   inclusive bounds) → 200, value round-trips unchanged.
4. **Full unauthenticated PUT case** (Clerk `userId` null) → 401
   `UNAUTHENTICATED`, `lookup` never consulted, `getSupabaseClient` never
   called (the Coder's suite only had this variant for `GET`; `PUT` only had
   the "JWT missing" variant, not the "no Clerk session at all" variant).
5. **`route.ts` `GET` delegation**, driven through the actual exported
   `GET`/`PUT` functions (not `handler.ts` directly) with a real
   `requireAuth` → `users`-table lookup satisfied via a table-name-aware
   Supabase fake, confirming the thin wrapper truly wires through to the
   handler and returns its response untouched.
6. **`route.ts` `PUT` delegation** with a malformed body → 400
   `VALIDATION_FAILED`, same wiring check as above.

All 7 pass. Combined with the Coder's 22, the route now has 29 dedicated
tests.

## Full suite after additions

`bun run test` — **83 suites / 1069 tests passed**, 0 failures. No
regressions in any pre-existing suite.

## Spec edge cases: coverage confirmed

All 15 edge cases enumerated in `.pipeline/spec.md` ("Edge cases the
implementation MUST handle") are covered by the combined test files:
no-row GET (defaults, no insert), no-row PUT (merge onto defaults + insert),
BR-14 explicit / via-merge / not-violated / re-enable, empty-body no-op,
malformed body (null, array, wrong types), out-of-range and boundary
`reminderHoursBefore` (0, 169, 1.5, "24", 1, 168), unknown-key stripping,
`chat_preference` never read/written, missing-JWT 401 (GET and PUT), fully
unauthenticated 401 (GET and PUT), DB error on select and on upsert (500),
and the `{ data: { preferences } }` / `{ error, code }` response envelopes.

## Failure cases exercised

- Malformed/invalid request bodies (null, array, wrong field types,
  out-of-range and non-integer `reminderHoursBefore`) → 400.
- BR-14 violation (direct and via-merge) → 422, confirmed no upsert issued.
- Missing JWT and missing Clerk session → 401, confirmed no Supabase client
  is even constructed.
- DB error on the pre-write select, and on the upsert itself → 500, never
  leaking the driver error message.

## Notes for the Reviewer

- No implementation code in `app/`, `lib/`, or `schemas/` was modified by
  this stage — only a new supplemental test file was added
  (`tests/unit/app/api/notification-preferences-route-tester-supplement.test.ts`).
- Confirmed by direct inspection (not just trusting `changes.md`) that
  `chat_preference` never appears in the shared `COLUMNS` select string, the
  upsert payload, or `NotificationPreferencesRow`/`NotificationPreferencesResponse`.
- Confirmed no migration or RLS files were touched — matches what
  `changes.md` claims.

## Files added by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-70/tests/unit/app/api/notification-preferences-route-tester-supplement.test.ts`

No implementation files were modified. Ready for Review.
