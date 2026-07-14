# Changes — Issue #59: Event CRUD + BR-10 time validation (Sprint 3)

## Summary

Implemented the four `/api/events` endpoints (previously `notImplemented`
stubs), mirroring the `service-weeks` handler pattern per the spec, including
BR-10 time-window/order validation as a pure helper reused on both create and
update.

## Files changed

- **`schemas/events.ts`** (replaced placeholder `z.object({})`):
  - `eventTypeSchema` — enum of the 4 event types.
  - `createEventSchema` — POST body shape (camelCase: `serviceWeekId`, `type`,
    `name`, `location`, `startTime`, `endTime`, `notes`). `startTime`/`endTime`
    use `z.string().datetime({ offset: true })`.
  - `updateEventSchema` — PUT body, all fields optional, `.refine` requiring
    at least one present. `serviceWeekId` intentionally not updatable.
  - `validateEventTiming(serviceDate, startTime, endTime)` — pure BR-10 check:
    `end > start` required, and both endpoints must be within ±72h
    (`BR10_WINDOW_MS`) of `serviceDate` anchored at 00:00:00 UTC. Returns an
    error message string or `null`.

- **`app/api/events/handler.ts`** (new): `toEventResponse` (snake→camel
  mapper, does not expose `google_calendar_event_id`), `listEvents`,
  `createEvent`.
  - `listEvents`: any authenticated role. Admins see all events in the
    church group (`order by start_time asc`). All non-admins (set_leader,
    member, guest) are scoped to events whose `service_week_id` is in the
    caller's `invitations` — this is broader scoping than service-weeks
    (where only guests are scoped), per spec.
  - `createEvent`: admin/set_leader only. Validates body shape (400 on
    failure), fetches the parent `service_weeks.service_date` scoped to the
    caller's church group (404 if missing/cross-group), then runs BR-10 via
    `validateEventTiming` (422 `VALIDATION_FAILED` on violation, distinct
    from the 400 Zod-shape failure). Inserts with a narrow
    `as unknown as ... Insert` cast matching the `service-weeks` pattern.

- **`app/api/events/[id]/handler.ts`** (new): `updateEvent`, `deleteEvent`.
  - `updateEvent`: admin/set_leader only. Fetches the existing event scoped
    to the church group (404 if missing). If `startTime` and/or `endTime` is
    present in the body, re-fetches the parent week's `service_date` and
    re-runs BR-10 against the *effective* start/end (new value if provided,
    else the existing row's value) — 422 on violation. Builds an `Update`
    patch only from keys present in the parsed body (so an explicit `null`
    for `location`/`notes` clears the column, and omission leaves it
    unchanged).
  - `deleteEvent`: admin/set_leader only, hard delete scoped to the church
    group; selects the deleted `id` so a missing/cross-group id returns 404
    instead of a silent 200. `event_attendees` children are left to the DB
    cascade (not deleted here).

- **`app/api/events/route.ts`** (replaced stub): wires `GET` → `listEvents`,
  `POST` → `createEvent`.

- **`app/api/events/[id]/route.ts`** (replaced stub): wires `PUT` →
  `updateEvent`, `DELETE` → `deleteEvent`. No `GET` (event-level read is
  #60's scope).

- **`.pipeline/spec.md`**: committed the planning stage's spec for #59 (was
  present in the working tree but not yet committed on this branch).

## Out of scope (untouched, per spec)

- `app/api/events/[id]/attendees/**` (issue #60 stubs) — left as-is.
- `google_calendar_event_id` (issue #62) — never read or written.
- No `GET /api/events/:id` was added.

## Verification run

- `bun run lint` — clean (no errors/warnings).
- `bun run typecheck` — clean (`tsc --noEmit`, no errors).
- `bun run test` — 51 suites / 580 tests, all passing (no existing test
  touches the new event handlers yet — this repo's convention, per the spec,
  is for the Tester stage to add the event route tests, copying the harness
  from `songs-route.test.ts` / `service-weeks-*` tests).

## What the Tester should focus on

- BR-10 order edge case: `end_time === start_time` must be 422 (not just
  `end < start`).
- BR-10 window edge case: exactly at the 72h boundary (`Math.abs(...) >
  BR10_WINDOW_MS`, so exactly 72h is valid, one ms over is not).
- 400 vs 422 split: malformed body (bad enum/uuid/datetime, missing `name`)
  → 400; syntactically valid body that violates BR-10 → 422.
- `createEvent` 404 on an unknown or cross-group `serviceWeekId` (must not
  leak existence).
- `updateEvent`/`deleteEvent` 404 on unknown/cross-group event `id`.
- `updateEvent` BR-10 re-check logic when only one of `startTime`/`endTime`
  is supplied (effective value falls back to the existing row).
- `listEvents` role scoping: admin sees all; set_leader/member/guest with no
  invitations get `{ events: [] }`; a non-admin only sees events for weeks
  they're invited to, never another group's events.
- `location`/`notes` null-vs-omit semantics on create and update.
- 401/403 paths (missing Clerk auth, missing supabase JWT, wrong role on
  POST/PUT/DELETE).
