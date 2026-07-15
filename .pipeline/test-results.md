# Test Results — Issue #60: Event attendee assignment

This overwrites the stale `test-results.md` for issue #58 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Summary
All checks pass. Added an independent unit-test suite for the new
`assignAttendee`/`removeAttendee` handlers and re-ran the full verification
suite (lint, typecheck, test) against the coder's claims in `changes.md`.
Nothing in the implementation was patched — only tests were added.

## What I did
1. Read `.pipeline/changes.md` and `.pipeline/spec.md` for issue #60.
2. Read the implementation: `app/api/events/[id]/attendees/handler.ts`,
   `app/api/events/[id]/attendees/route.ts`,
   `app/api/events/[id]/attendees/[userId]/route.ts`, and the
   `assignAttendeeSchema` addition in `schemas/events.ts`.
3. Read the reference test pattern
   (`tests/unit/app/api/events-id-route.test.ts`) and the underlying
   `lib/api/auth.ts` / `lib/api/response.ts` / `lib/api/errors.ts` contracts
   the mocks need to satisfy.
4. Wrote a new independent test file:
   `tests/unit/app/api/events-id-attendees-route.test.ts` (28 tests), using
   the same `jest.mock`/`makeLookup`/table-fixture harness pattern as the
   sibling suite, extended with an `insert` fixture (the sibling only needed
   `select`/`update`/`delete`).
5. Ran `bun run test` (new suite standalone, then full suite), `bun run
   lint`, `bun run typecheck`.

## New test coverage (`tests/unit/app/api/events-id-attendees-route.test.ts`)

`toAttendeeResponse`:
- Maps a raw `event_attendees` row to the camelCase `AttendeeResponse` shape.

`POST /api/events/[id]/attendees` (`assignAttendee`) — happy path:
- 201 with the created attendee; insert payload is exactly
  `{ event_id, user_id }` (no `id`/`created_at` sent).
- `set_leader` role is also allowed (not just `admin`).

Auth/role (failure cases):
- 401 UNAUTHENTICATED when Clerk `userId` is null — `lookup` never
  consulted.
- 401 UNAUTHENTICATED when `getToken` yields no JWT — `getSupabaseClient`
  never called.
- 403 FORBIDDEN for `member` and `guest` roles — `getSupabaseClient` never
  called.

Validation (spec-named edge cases):
- 400 VALIDATION_FAILED for missing `userId`.
- 400 VALIDATION_FAILED for a non-uuid `userId`.
- 400 VALIDATION_FAILED for a malformed/non-JSON body.

Event scoping (spec-named edge case, ordering assertion):
- 404 NOT_FOUND when the event is missing/cross-tenant, **and** asserts the
  `invitations` table was never queried (confirms the 404 check happens
  before the confirmed-member business rule, per spec Decisions).
- 500 INTERNAL when the event lookup errors.

Confirmed-member rule (spec-named edge case):
- 422 VALIDATION_FAILED when there's no accepted invitation for the
  target user on the event's `service_week_id`.
- 500 INTERNAL when the invitation lookup errors.

Duplicate assign (spec-named edge case, ordering assertion):
- 409 CONFLICT when already assigned, **and** asserts `insert` was never
  called on `event_attendees` (confirms the pre-check runs before the
  insert attempt).
- 500 INTERNAL when the duplicate-check lookup errors.

Insert failure modes:
- 500 INTERNAL when the insert itself errors.
- 500 INTERNAL when the insert returns no row despite no error (defensive
  branch in the handler).

`DELETE /api/events/[id]/attendees/[userId]` (`removeAttendee`):
- 200 `{ deleted: true }` happy path; `set_leader` also allowed.
- 401 UNAUTHENTICATED (no Clerk user; no JWT) — mirrors the same two auth
  failure cases as POST.
- 403 FORBIDDEN for `member`/`guest`.
- 404 NOT_FOUND when the event is missing/cross-tenant, **and** asserts
  `event_attendees` was never queried (delete never attempted against a
  foreign/missing event).
- 500 INTERNAL when the event lookup errors.
- 404 NOT_FOUND when the delete matches no row (member wasn't assigned).
- 500 INTERNAL when the delete errors.

## Verification run

- `bun run test -- tests/unit/app/api/events-id-attendees-route.test.ts`
  → **28/28 passed**.
- `bun run lint` → clean, no errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) → clean, no errors.
- `bun run test` (full suite) → **59 suites / 757 tests, all passing**
  (58 suites / 729 tests from the coder's baseline in `changes.md`, plus 1
  new suite / 28 new tests added by this stage: 729 + 28 = 757, consistent).

## Independent code read against spec.md

Read `app/api/events/[id]/attendees/handler.ts` line by line against the
spec's `assignAttendee`/`removeAttendee` flow descriptions. Confirmed:

- Role matrix matches spec exactly: both endpoints `requireRole(ctx,
  ["admin", "set_leader"])`; `member`/`guest` are rejected before any
  Supabase call.
- Event lookup is scoped by `church_group_id` and checked (404) **before**
  the confirmed-member/invitation lookup in `assignAttendee`, and before the
  delete attempt in `removeAttendee` — matches the spec's explicit ordering
  requirement ("so a foreign event never leaks state"). Verified via tests
  that assert `invitations`/`event_attendees` are never queried on the 404
  path.
- "Confirmed member" query matches spec exactly:
  `.from("invitations").eq("church_group_id", ...).eq("service_week_id",
  event.service_week_id).eq("user_id", ...).eq("status", "accepted")` — no
  row → 422 VALIDATION_FAILED, not 404 or 400.
- Duplicate-assign check queries `event_attendees` by `event_id`+`user_id`
  and returns 409 CONFLICT before attempting the insert, exactly as
  specified (verified the insert mock is never invoked on that path).
- Insert payload is `{ event_id: eventId, user_id: parsed.userId }` only —
  matches spec's note that `id`/`created_at` are DB-defaulted, no cast
  needed.
- `toAttendeeResponse` maps `id`/`event_id`/`user_id`/`created_at` to the
  camelCase `AttendeeResponse` shape exactly as the spec's type signature
  requires.
- Every Supabase `.error` branch (event lookup x2, invitation lookup,
  duplicate lookup, insert, delete) maps to `fail("Internal error",
  ErrorCode.INTERNAL, 500)`, matching the spec and the sibling handler's
  idiom.
- Both functions wrap in `try/catch` mapping `ApiException` → `fail(err
  .message, err.code, err.status)`, else generic 500 — matches spec and
  sibling handler exactly.
- Route wiring (`route.ts` files) unwraps `params: Promise<{...}>` and
  delegates straight to the handler with no extra logic, matching
  `app/api/events/[id]/route.ts`'s pattern.
- `schemas/events.ts`'s `assignAttendeeSchema = z.object({ userId:
  z.string().uuid() })` matches spec exactly; confirmed via the 400 tests
  for missing/non-uuid `userId`.
- No DB migrations, no notification/GCal code — `git status`/diff shows
  only the files `changes.md` lists as created/modified, plus the one new
  test file added by this stage. Confirms the "out of scope, belongs to
  #62" constraint was respected.

## Failure cases exercised

Per the pipeline contract's requirement to cover at least one failure case,
the following were independently confirmed:

- Malformed/non-JSON POST body → 400 VALIDATION_FAILED (via `req.json()`
  rejecting, caught by `.catch(() => null)` then failing Zod parse).
- Non-uuid `userId` → 400 VALIDATION_FAILED (Zod `.uuid()` constraint).
- Unconfirmed member (no accepted invitation) → 422 VALIDATION_FAILED.
- Already-assigned member → 409 CONFLICT.
- Cross-tenant/missing event → 404 NOT_FOUND on both endpoints, without
  leaking state via a subsequent query.
- Every Supabase `.error` branch on both endpoints → 500 INTERNAL.

## Verdict
PASS. No failures found. The implementation matches the spec's decisions
(confirmed-member definition, 404-before-422/409 ordering, 409-before-insert
ordering, 500 mapping on every Supabase `.error` branch) and the coder's
`changes.md` claims hold up under independent testing. Ready for Review.
