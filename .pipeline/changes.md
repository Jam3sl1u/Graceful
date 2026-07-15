# Changes — Issue #60: Event attendee assignment

## Summary
Implemented the two `event_attendees` endpoints (assign / remove) that were
previously 501 stubs, plus the Zod schema for the POST body. No DB
migrations, no notification/GCal code (explicitly out of scope, belongs to
#62).

## Files changed

### `app/api/events/[id]/attendees/handler.ts` (NEW)
- `toAttendeeResponse(row)` — maps an `event_attendees` row to the camelCase
  `AttendeeResponse` shape (`id`, `eventId`, `userId`, `createdAt`).
- `assignAttendee(req, eventId, lookup?)` — POST handler, `admin`/`set_leader`
  only. Flow: auth/role guard → parse `{ userId }` body (400 on failure) →
  supabase JWT client (401 if missing) → load event scoped by
  `church_group_id` (404 if absent — checked before any business-rule check
  so a foreign event never leaks state) → confirmed-member check against
  `invitations` (`status = 'accepted'`, same `service_week_id`, same
  `church_group_id`) → 422 if not confirmed → duplicate-assignee check
  against `event_attendees` → 409 if already assigned → insert row → 201
  with `{ attendee }`.
- `removeAttendee(req, eventId, targetUserId, lookup?)` — DELETE handler,
  same auth/role guard. Loads event scoped by `church_group_id` (404 if
  absent), then deletes the `event_attendees` row matching
  `event_id`/`user_id`; 404 if nothing was deleted (member wasn't
  assigned); otherwise `{ deleted: true }`.
- Both wrapped in try/catch mapping `ApiException` → `fail(...)`, else a
  generic 500 INTERNAL, matching the sibling `app/api/events/[id]/handler.ts`
  idiom exactly.

### `app/api/events/[id]/attendees/route.ts` (REPLACED stub)
Wires `POST` to `assignAttendee`, following the `app/api/events/[id]/route.ts`
params pattern (`{ id }` from `params` promise).

### `app/api/events/[id]/attendees/[userId]/route.ts` (REPLACED stub)
Wires `DELETE` to `removeAttendee`, passing both `id` and `userId` from the
route params.

### `schemas/events.ts` (MODIFIED)
Added `assignAttendeeSchema = z.object({ userId: z.string().uuid() })` and
its inferred `AssignAttendeeInput` type, appended at the end of the file
(after `validateEventTiming`, to avoid splitting the `BR10_WINDOW_MS`
constant from the function that uses it).

### `.pipeline/spec.md`
Overwritten by the planning stage for this run with the issue #60 spec
(per the pipeline contract, each run overwrites the prior stage's file).

## Verification
- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 58 suites / 729 tests, all passing (no new tests were
  added by this stage; the tester stage owns that per the pipeline
  contract's test guidance in spec.md).

## What the tester should focus on
- Happy-path assign (201) and remove (`{ deleted: true }`).
- Confirmed-member rejection (422 VALIDATION_FAILED) — invitation missing,
  or present but `status` is `pending`/`denied`/`withdrawn`/`expired`, or
  present but for a different `service_week_id`.
- Non-leader caller (`member`/`guest`) → 403 FORBIDDEN, and that the
  supabase client is never reached (mirrors existing sibling-handler tests).
- Missing/cross-tenant event → 404 NOT_FOUND on BOTH endpoints, checked
  before the confirmed-member lookup runs (assign should not query
  `invitations` at all when the event lookup 404s).
- Duplicate assign → 409 CONFLICT, verifying the pre-insert duplicate check
  fires before any insert is attempted.
- DELETE for a user not currently assigned → 404 NOT_FOUND.
- Malformed POST body (missing/non-uuid `userId`, non-JSON body) → 400
  VALIDATION_FAILED.
- Missing Clerk session / missing supabase JWT → 401 UNAUTHENTICATED on both
  endpoints.
- All Supabase `.error` branches (event lookup, invitation lookup,
  duplicate-check lookup, insert, delete) → 500 INTERNAL.
- Test pattern to reuse: `tests/unit/app/api/events-id-route.test.ts`
  (`jest.mock` of `@clerk/nextjs/server` and `@/lib/supabase/client`, the
  `makeChain`/`makeSupabaseClient` table-fixture harness keyed by table
  name, `makeLookup(role)` helper). This new handler touches three tables
  (`events`, `invitations`, `event_attendees`), so the fixture map will need
  entries for all three.
