# Changes — Issue #48: Build Week View screen (Admin / Set Leader)

## Summary

Implemented the Set Leader/Admin Week View screen per `.pipeline/spec.md`:
one backend read endpoint (completing the `GET /api/invitations` 501 stub
into a roster-safe, week-scoped list) plus the client screen that composes
it with four existing endpoints (service week, service-week list, roster
members, conflicts) and one non-critical endpoint (team availability).

## Backend

- **`schemas/invitations.ts`** — added `listInvitationsQuerySchema` /
  `ListInvitationsQuery` (`serviceWeekId: z.string().uuid()`), mirroring
  `getTeamAvailabilityQuerySchema`.
- **`app/api/invitations/handler.ts`** — added:
  - `WeekInvitation` type (roster-safe: `id`, `serviceWeekId`, `userId`,
    `roleNote`, `status`, `responseDeadline`, `createdAt`). Deliberately does
    **not** reuse `InvitationResponse`/`toInvitationResponse`, since those
    include `responseToken` (the no-session credential) and `denial_reason`.
  - `toWeekInvitation` mapper.
  - `listInvitations(req, lookup?)`: `requireAuth` + `requireRole(["admin",
    "set_leader"])`, parses `req.nextUrl.searchParams` via
    `listInvitationsQuerySchema` (400 on failure), queries `invitations`
    filtered by `service_week_id` + `church_group_id`, ordered by
    `created_at`, selecting **explicit columns only** (never `select("*")`)
    so `response_token`/`denial_reason` never reach the response. Same
    try/catch → `ApiException`/`fail`/500 pattern as the other handlers.
- **`app/api/invitations/route.ts`** — replaced the `notImplemented("GET
  /api/invitations")` stub with `listInvitations(req)`. `POST` (→
  `createInvitation`) is untouched.

## Frontend

- **`app/(app)/week/[id]/page.tsx`** — replaced the placeholder stub with a
  server component that awaits `params` and renders `<WeekView
  serviceWeekId={id} />`, mirroring `app/(public)/invite/[token]/page.tsx`.
- **`app/(app)/week/[id]/week-view.tsx`** (new) — `"use client"` component.
  One `useEffect` fires `Promise.all` of the five core fetches
  (`GET /api/service-weeks/:id`, `GET /api/service-weeks`,
  `GET /api/church-group/members`, `GET /api/invitations?serviceWeekId=`,
  `GET /api/conflicts`); after that resolves and the week's `serviceDate` is
  known, a further non-critical `GET /api/availability/team?startDate=&endDate=`
  fetch is issued for the sidebar (its 7-day UTC window is computed from
  `serviceDate`, so it cannot be part of the initial parallel batch).
  - View states: `"loading" | "ready" | "forbidden" | "not-found" | "error"`.
    A 404 on the service-week fetch → not-found; a 403 on any of the four
    other core fetches → forbidden; any other non-OK/thrown → error. The
    week-list and availability fetches are treated as non-critical and
    degrade to empty nav/sidebar instead of blocking `"ready"`.
  - Header: service date (`formatServiceDate`, copied from
    `invite-response.tsx`), title (falls back to "Untitled service"), a
    `Badge` (`Cancelled`/danger when `isCancelled`, else a static `Draft`/
    neutral with a `TODO(Sprint 3 #64)`), and prev/next nav arrows computed
    from the `service-weeks` list's sort order (`getNeighborWeekIds`).
  - Roster grid: one slot per `DirectoryMember`. `getCurrentInvitation` picks
    the max-`createdAt` `WeekInvitation` per member; `getRosterStatus` maps
    it to Conflict (red, checked first) / Confirmed / Pending / Declined /
    Open (with a non-functional "+ Invite" `Button`), matching the spec's
    precedence table. Initials avatar via `getInitials`.
  - Collapsible availability sidebar (`useState<boolean>` toggle): a
    CSS-grid table with rows = availability members (name resolved via the
    roster map) and columns = the 7-day window (`getAvailabilityWindow`,
    UTC-based via `addDaysUTC`), each cell colored by `isAvailable` (blank/
    grey when no entry).
  - Events and Setlist cards: static placeholders per spec
    (`TODO(#59)` / `TODO(Sprint 3 #64)`), each with a non-functional button.
- **`app/(app)/week/[id]/week-view.module.css`** (new) — plain CSS module,
  desktop-first two-column layout (main + sidebar), roster grid, sidebar
  collapse states, availability grid cell coloring. Follows
  `invite-response.module.css`'s conventions.

## Tests

- **`tests/unit/app/api/invitations-list-route.test.ts`** (new) — covers:
  403 for a member; 400 for missing/non-uuid `serviceWeekId`; 401 with no
  JWT; happy path returns the week-scoped list and asserts the response
  never has a `responseToken` key (and the selected columns string isn't
  `"*"` and doesn't mention `response_token`); empty list; 500 on a query
  error.
- **`tests/unit/app/week-view.test.tsx`** (new) — covers: loading → ready;
  header (title, Draft badge, Events/Setlist placeholder cards); roster
  status mapping for all five states, explicitly asserting the
  conflict-overrides-accepted case and that "+ Invite" renders only on the
  Open slot; nav arrows link to the correct prev/next ids; cancelled week
  shows the Cancelled badge instead of Draft; sidebar collapse/expand
  toggle; 403 on a core fetch → forbidden view; 404 on the service-week
  fetch → not-found view; week-list/availability failures degrade
  gracefully (still "ready", empty nav/sidebar); empty roster renders an
  empty state; a network error on the core fetches → error view.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run test` — 42 suites / 496 tests passed (includes the two new test
  files above plus the full existing suite, unchanged elsewhere).

## What the Tester should focus on

- The roster-safety assertion in `invitations-list-route.test.ts` (no
  `responseToken`/`response_token` anywhere in the response or the executed
  `select(...)` column string) — this was called out in the spec as the
  single most important backend correctness point.
- The conflict-precedence logic (`getRosterStatus` in `week-view.tsx`): an
  accepted-but-conflicted invitation must render "Conflict", not
  "Confirmed" — covered by a dedicated test but worth an independent look.
- The 403→forbidden / 404→not-found routing in `week-view.tsx`'s load
  effect, since the `(app)` layout does not itself enforce role (per its own
  TODO) — the client-side handling is the only gate today.
- Nav-arrow direction (`getNeighborWeekIds`): `GET /api/service-weeks` is
  ordered `service_date` desc, so index 0 is the newest week; verify the
  "prev"/"next" semantics still read naturally against real data.
