# Review — Issue #60: Event attendee assignment

VERDICT: SHIP

## What I verified (independently, not just from the summaries)
- Ran `git diff main...HEAD`: the only production changes are the new
  `app/api/events/[id]/attendees/handler.ts`, the two route files
  (stubs → real wiring), and the `assignAttendeeSchema` append in
  `schemas/events.ts`. No migrations, no notification/GCal code — the
  "belongs to #62" scope boundary is respected.
- Confirmed the Supabase types back every query: `EventAttendeesRow`
  (`id`/`event_id`/`user_id`/`created_at`, Insert makes `id`/`created_at`
  optional so the bare `{ event_id, user_id }` insert typechecks with no
  cast), `EventsRow.service_week_id`, and `InvitationsRow`
  (`service_week_id`/`user_id`/`status`/`church_group_id`).
- Confirmed `"accepted"` is a valid `InvitationStatus`
  (`types/domain.ts`: pending|accepted|denied|withdrawn|expired), matching
  the spec's confirmed-member definition; pending/denied/withdrawn/expired
  correctly fall through to 422.
- Ran `bun run typecheck` → clean.
- Ran the new suite `tests/unit/app/api/events-id-attendees-route.test.ts`
  → 28/28 pass. The tests import the REAL handler and mock only the
  Clerk/Supabase boundary (not the handler itself), so they exercise actual
  handler logic. They include the load-bearing ordering assertions:
  `invitations` is never queried on the event-404 path, and `insert` is
  never attempted on the 409 duplicate path.

## Correctness / security assessment
- Ordering matches spec and is security-correct: event lookup scoped by
  `church_group_id` runs BEFORE the confirmed-member and duplicate checks
  on POST, and before the delete on DELETE — a foreign/missing event returns
  404 without leaking state or allowing cross-tenant delete probing.
- Role gate (`admin`/`set_leader`) runs before any Supabase call;
  `member`/`guest` → 403 before the DB is touched.
- Duplicate assign returns 409 via an explicit pre-insert check rather than
  relying on the DB unique-violation, exactly as specced.
- Every Supabase `.error` branch maps to 500 INTERNAL; try/catch maps
  `ApiException` → `fail(...)` else generic 500, matching the sibling
  `app/api/events/[id]/handler.ts` idiom.
- Insert payload is `{ event_id, user_id }` only (no client-supplied
  `id`/`created_at`); response DTO is camelCase via `toAttendeeResponse`.

Body-parse (400) precedes the JWT check (401): an authenticated caller with
a malformed body but no Supabase JWT gets 400 before 401. This is exactly
the order the spec prescribes (step 2 parse, step 3 jwt) and is harmless —
noted, not a defect.

## Non-blocking note for the orchestration/human
The tester's suite
`tests/unit/app/api/events-id-attendees-route.test.ts` is present on disk
and green but is still UNTRACKED in git (`git status`: `??`). It therefore
does not appear in `git diff main...HEAD`. Whoever commits/opens the PR must
`git add` this file so the coverage actually ships with the change — if it
is left untracked the PR would merge the handler without its tests.

Verdict: SHIP. Code matches the spec exactly, types and enum values are
sound, tests are meaningful (real handler, boundary-only mocks, ordering
assertions) and pass, typecheck is clean. Just ensure the untracked test
file is committed before the PR is opened.
