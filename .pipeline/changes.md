# Changes — Issue #46: Conflict detection on availability change

## Summary

Wired the second (PUT) trigger point for BR-15 conflict detection, and added the
in-app admin/set_leader notification that was previously missing from the shared
`record_availability_conflict` RPC. The DELETE trigger point (#35) was already
wired before this change and is unmodified.

## Files changed

### `app/api/availability/handler.ts` (MODIFY)
In `setAvailability`, after the upsert succeeds, iterate `byDate` and for every
date where `isAvailable === false`, `await recordAvailabilityConflict(supabase,
date, "marked_unavailable")`. Tracks whether any call returned `true` into a new
`conflictTriggered` boolean, now included in the PUT 200 response body:
`ok({ availability, conflictTriggered })`. No new error handling was added — RPC
errors (`ApiException(INTERNAL, 500)`) propagate through the function's existing
`try/catch`, exactly as `deleteAvailability` already relies on. GET, DELETE,
validation, date expansion, and the dedupe logic are untouched.

### `supabase/migrations/20260713000001_conflict_notification.sql` (CREATE)
New append-only migration that `CREATE OR REPLACE`s
`public.record_availability_conflict` (signature, language, security, and
JWT/UNAUTHENTICATED guard unchanged from `20260711000001_availability_conflict_rpc.sql`,
which is left untouched). Behavioral addition: after each `conflicts` insert
(now capturing `RETURNING id INTO v_conflict_id`), the RPC inserts one
`notifications` row per `admin`/`set_leader` in the church group, excluding the
triggering user (`id <> v_user_id`). Notification body is
`"<member name> can no longer make <service label>[ — reason: <note>]"`, where
the service label prefers `service_weeks.title` and falls back to
`'the service on ' || service_date`, and the reason clause is included only when
the member's `availability.note` for that date is non-null (present on the
`marked_unavailable` path, absent on `availability_deleted` since the row is
already gone by the time the RPC runs). Notifications are inserted from this
SECURITY DEFINER RPC (not the route handler) because
`notifications_insert_leader_admin` RLS is leader/admin-only. Includes a
`-- TODO(#58/#59): dispatch SMS + email...` comment per the repo's deferred-
dispatch convention (no `sendSms`/`sendEmail` calls added), a header comment
explaining the SECURITY DEFINER rationale, and a commented DOWN section
matching sibling migrations. `record_availability_conflict`'s signature/return
type in `lib/supabase/types.ts` is unchanged, so that file was not touched (per
spec).

### `tests/unit/app/api/availability-route.test.ts` (MODIFY)
- `makeSupabaseClientForPut` now also returns a mocked `rpc` (defaulting to
  `{ data: false, error: null }` when unspecified), mirroring
  `makeSupabaseClientForDelete`'s shape.
- Added four new tests to the `describe("PUT /api/availability")` block:
  1. Marking a date unavailable calls `rpc("record_availability_conflict", { p_date, p_trigger_reason: "marked_unavailable" })` and the 200 body reports `conflictTriggered: true` when the RPC returns `true`.
  2. Marking a date available (or omitted, defaulting to available) never calls `rpc`, and `conflictTriggered: false`.
  3. A multi-date PUT mixing available/unavailable dates calls `rpc` exactly once, only for the unavailable date.
  4. RPC returning `{ data: null, error: {...} }` yields a 500 `INTERNAL` response (propagated via the existing catch).
- No existing PUT test needed updating for the new `conflictTriggered` field — all
  existing assertions read `body.data.availability` specifically rather than
  asserting `body.data` by full equality.

### `tests/unit/lib/scheduling/conflict-detection.test.ts` (MODIFY — minor)
Added one test asserting `recordAvailabilityConflict` forwards the
`"marked_unavailable"` reason verbatim to the RPC call args (existing cases only
covered `"availability_deleted"`). No behavior change to
`recordAvailabilityConflict` itself.

## Explicitly not touched (per spec's "out of scope")
- No SMS/email dispatch — TODO comment only.
- `GET /api/conflicts`, `POST /api/conflicts/[id]/resolve`, `app/(app)/conflicts/page.tsx` — untouched stubs.
- `lib/supabase/types.ts` — not widened (RPC signature/return unchanged).
- GET /availability, team availability, admin-sets-another-member paths — untouched.

## Verification run (Coding stage)
- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 31 suites / 385 tests, all passing (includes the 4 new PUT
  tests, 1 new conflict-detection unit test, and the full existing suite with no
  regressions).
- `bun run check:workflows` — OK (no workflow scripts were touched by this
  change; ran only as a sanity check per repo convention).

## What the Tester should focus on
- The RPC migration (`20260713000001_conflict_notification.sql`) has no live-DB
  test harness in this repo (consistent with `accept_invitation` and the
  original `record_availability_conflict` migration) — it is only exercised via
  mocked-client route/unit tests. The Tester should review the SQL body closely
  for correctness (recipient exclusion, NULL-note handling, service label
  fallback, `RETURNING id INTO v_conflict_id` wiring) rather than expecting a
  live-DB test.
- Confirm the PUT response shape change (`conflictTriggered` added alongside
  `availability`) doesn't break any caller outside the files touched here (a
  repo-wide grep for consumers of the PUT response was not in scope for this
  spec, but worth a quick check).
- Multi-date / range PUT with a mix of available and unavailable dates — verify
  only unavailable dates trigger the RPC (edge case 2 in the spec).
