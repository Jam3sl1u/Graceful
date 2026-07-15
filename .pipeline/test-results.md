# Test Results — Issue #59: Event CRUD + BR-10 time validation (Sprint 3)

This overwrites the stale `test-results.md` for issue #53 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: PASS

## What I did

1. Read `.pipeline/changes.md` and `.pipeline/spec.md`, then independently
   read the actual implementation: `schemas/events.ts`,
   `app/api/events/handler.ts`, `app/api/events/[id]/handler.ts`,
   `app/api/events/route.ts`, `app/api/events/[id]/route.ts`. Confirmed the
   code matches the spec's file-by-file description (auth flow, BR-10
   400-vs-422 split, role scoping, patch semantics).
2. Wrote three new test files, copying the mocking harness used by
   `service-weeks-route.test.ts` / `service-weeks-id-route.test.ts`
   (Clerk `auth` + `getSupabaseClient` mocked, `lookup` seam injected,
   chainable Supabase mock covering `select/insert/update/delete` +
   `eq/order/in/maybeSingle/then`):
   - `tests/unit/schemas/events.test.ts` — pure unit tests for
     `validateEventTiming` (BR-10) and `createEventSchema`/`updateEventSchema`
     shape rules, independent of the handler/HTTP layer.
   - `tests/unit/app/api/events-route.test.ts` — `listEvents` (GET) and
     `createEvent` (POST).
   - `tests/unit/app/api/events-id-route.test.ts` — `updateEvent` (PUT) and
     `deleteEvent` (DELETE).
3. Ran `bun run lint`, `bun run typecheck`, and `bun run test` (full suite,
   not just the new files) to independently verify, rather than trusting the
   coder's verification claims in `changes.md`.

## Verification run (independently re-run, not trusted from changes.md)

- `bun run lint` — clean, 0 errors / 0 warnings (fixed 6 unused-destructured-var
  warnings I introduced in my own test files by prefixing with `_`, matching
  repo convention).
- `bun run typecheck` — clean, `tsc --noEmit`, 0 errors.
- `bun run test` — **54 suites / 658 tests, all passing** (up from the
  coder's reported 51 suites / 580 tests — the delta is my 3 new files: 78
  new tests, 0 failures).

## Coverage against the spec's "what the Tester should focus on" list

All items in `changes.md`'s "What the Tester should focus on" section are
covered:

- **BR-10 order edge case** — `end_time === start_time` → 422 (not just
  `end < start`). Covered in both the pure schema test (`schemas/events.test.ts`)
  and end-to-end via `createEvent`/`updateEvent`.
- **BR-10 window boundary** — exactly ±72h is valid (`Math.abs(...) >
  BR10_WINDOW_MS`, not `>=`), one ms over/under is not. Covered with exact
  boundary-ms arithmetic in `schemas/events.test.ts` (4 boundary tests: +72h
  exact/+1ms over, -72h exact/-1ms under), plus a "start OK but end violates"
  asymmetric case.
- **400 vs 422 split** — malformed body (bad enum, missing name, non-uuid,
  non-ISO datetime, missing offset) → 400 `VALIDATION_FAILED`; syntactically
  valid body violating BR-10 → 422 `VALIDATION_FAILED`. Both codes and status
  values asserted separately in the route tests so a regression that
  collapses the two would be caught.
- **`createEvent` 404 on unknown/cross-group `serviceWeekId`** — asserted via
  a null `service_weeks` fixture; response body checked to be generic
  `NOT_FOUND` (no existence leak).
- **`updateEvent`/`deleteEvent` 404 on unknown/cross-group id** — asserted
  for both a null `events` select fixture (update) and null `events` delete
  fixture (delete's tenant-scoped race case).
- **`updateEvent` BR-10 re-check with only one of start/end supplied** —
  two dedicated tests: only `startTime` provided (falls back to existing
  `end_time`, and is asserted to actually trip a 422 when the new start
  moves past the existing end — proving the fallback value is real, not just
  present), and only `endTime` provided (falls back to existing `start_time`,
  accepted as valid). Also a test asserting `service_weeks` is *not* queried
  at all when neither time field changes (would catch an accidental
  always-re-check regression as well as a "never re-checks" regression).
- **`listEvents` role scoping** — admin sees all; each of
  set_leader/member/guest is parametrized (`it.each`) for both "has an
  invitation → sees the event" and "zero invitations → `{ events: [] }`".
- **`location`/`notes` null-vs-omit semantics** — create: omitted → stored
  `null`; update: explicit `null` clears the column (payload asserted to be
  exactly `{ location: null }`, not merged with other fields), omission
  leaves the column out of the patch entirely (payload asserted to lack the
  key via `not.toHaveProperty`).
- **401/403 paths** — no Clerk `userId` (lookup never consulted, asserted via
  `expect(lookup).not.toHaveBeenCalled()`), no Supabase JWT (`getSupabaseClient`
  never called), and wrong role (member/guest) on POST/PUT/DELETE, including
  confirming `set_leader` *is* allowed (not just admin) on all three mutating
  endpoints.

## Additional cases beyond the spec's list

- `google_calendar_event_id` is never exposed in `GET /api/events` responses
  even when present on the underlying row (guards against the #62-scope leak
  the spec calls out as out-of-scope-but-must-not-leak).
- 500 `INTERNAL` on every Supabase query point that can independently fail:
  events select/insert/update/delete, invitations select, and the
  service_weeks lookup (both on create and on the update-time BR-10
  re-check).
- Tenant-isolation assertion for `deleteEvent` — captures the actual `.eq()`
  call arguments to confirm the delete is scoped to
  `id + church_group_id` in that order, not just "returns the right status."

## One bug I found and fixed in my own tests (not the implementation)

My first draft of `events-route.test.ts` used a non-UUID placeholder
(`"week-1"`) as `WEEK_ID`, which is also used as the `serviceWeekId` value in
POST bodies. Since `createEventSchema.serviceWeekId` is `z.string().uuid()`,
every `createEvent` test with a non-UUID `WEEK_ID` was actually failing
`safeParse` and returning 400 — even the ones asserting 201/404/422/500 —
which surfaced as 9 failing tests on the first run (correctly caught,
nothing swallowed silently). Fixed by using a real UUID literal
(`"22222222-2222-2222-2222-222222222222"`) for `WEEK_ID`; re-ran and all 78
new tests pass for the intended reason. This was a bug in my test fixture,
not in the implementation under test — noted here for the Reviewer's
awareness.

## Files added

- `tests/unit/schemas/events.test.ts`
- `tests/unit/app/api/events-route.test.ts`
- `tests/unit/app/api/events-id-route.test.ts`

No implementation files were modified — per the pipeline contract, this
stage only tests, it does not patch around failures. No failures remained
after fixing my own fixture bug above.
