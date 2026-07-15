# Review — Issue #59: Event CRUD + BR-10 time validation (Sprint 3)

VERDICT: SHIP

## What I verified (independently, not trusted from prior stages)

- Ran `git diff main...HEAD` and read every changed implementation file
  firsthand: `schemas/events.ts`, `app/api/events/handler.ts`,
  `app/api/events/[id]/handler.ts`, and both `route.ts` files.
- Cross-checked against the reference pattern (`app/api/service-weeks/handler.ts`)
  — auth flow, JWT acquisition, narrow Insert cast, try/catch → `fail(...)`
  shape, and camelCase convention all match.
- Cross-checked types against `lib/supabase/types.ts` (`EventsRow`, `Insert`,
  `Update`) and `types/domain.ts` (`EventType`): every field `toEventResponse`
  reads exists and is correctly typed; `google_calendar_event_id` is correctly
  NOT exposed.
- Re-ran the full gate myself: `bun run lint` (clean), `bun run typecheck`
  (clean), `bun run test` (54 suites / 658 tests, all pass, incl. the tester's
  78 new event tests).

## Correctness assessment (green tests AND correct behavior)

- **400-vs-422 split (the crux):** Zod shape failures return 400; a
  syntactically valid body that violates BR-10 returns 422. Verified in both
  the handler code and the route tests, which assert status AND `code`
  separately so a collapse of the two would be caught.
- **BR-10 helper:** `end > start` strict (equal times rejected), ±72h absolute
  window with `>` (exactly 72h valid, +1ms invalid). Unit tests hit the
  boundary to the millisecond, plus the asymmetric start-ok/end-violates case.
- **Auth precedence:** `requireRole` runs before body parse, so a wrong-role
  caller gets 403 (not 400) even with a malformed body — matches the
  service-weeks precedent; tenant isolation via `church_group_id` on every
  query; generic 404 (no existence leak) on cross-group ids.
- **updateEvent BR-10 re-check** correctly uses effective start/end (new value
  or existing row fallback) and skips the week lookup when neither time
  changes. Patch is built only from present keys; `updateEventSchema`'s
  `.refine` guarantees at least one recognized key survives stripping, so no
  empty `.update({})` can occur.
- **Null-vs-omit** semantics on `location`/`notes` are correct on both create
  (omit → null) and update (explicit null clears, omit leaves unchanged).

## Non-blocking notes (for human awareness, not fixes required)

1. BR-10 anchor is service_date at 00:00:00 UTC with a symmetric ±72h absolute
   window (spec Decision #2). This is deterministic and documented, but means
   an event up to 72h *before* the service date is valid and the church
   group's timezone is ignored. Defensible for this self-contained issue; a
   human may want group-tz-relative windows later.
2. `deleteEvent` relies on a DB-level ON DELETE CASCADE for `event_attendees`
   (per spec, #60's scope). Worth a human confirming the FK is actually
   defined with cascade in the migration — out of scope to change here.

Neither note changes behavior for the AC in scope. Implementation matches the
spec file-by-file, tests are meaningful and boundary-precise, all gates green.
