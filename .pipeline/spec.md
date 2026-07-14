# Spec — Issue #48: Build Week View screen (Admin / Set Leader)

## OPEN QUESTIONS

**None blocking.** There is one scope judgment call (a small read endpoint the
screen needs but the issue doesn't literally name) documented under "Design
decision" below; it follows this repo's existing precedent (see the prior
`spec.md` for #51, which created an implied-but-unnamed module) and does not
need a human to resolve before coding. Secondary non-blocking assumptions are
listed under "Assumptions" — a reviewer can override any of them cheaply.

## Design decision (read this first)

The screen is the Set Leader's planning workspace for one service week. I read
the actual backend and found the data sources split three ways:

**Available today (build against these):**

- `GET /api/service-weeks/:id` → `{ serviceWeek }` (`ServiceWeekResponse`:
  `serviceDate`, `title`, `isCancelled`, …). Header data.
- `GET /api/service-weeks` → `{ serviceWeeks }` ordered `service_date` desc.
  Used to compute prev/next week for the nav arrows.
- `GET /api/availability/team?startDate=&endDate=` →
  `{ startDate, endDate, members: TeamAvailabilityMember[] }`
  (set_leader/admin only). Availability sidebar (this is #36).
- `GET /api/church-group/members` → `{ members: DirectoryMember[] }`
  (`id`, `name`, `role`, `vocalCapability`, `instruments`; no avatar URL).
  Roster names/identity.
- `GET /api/conflicts` → `{ conflicts: OpenConflict[] }` (set_leader/admin).
  Each has `invitationId`, `memberId`, `serviceWeekId`. Conflict flag per slot.

**NOT available (render as incremental placeholders, do NOT build the backend):**

- `GET /api/events` → 501 stub. Events land in #59.
- `GET /api/service-weeks/:id/setlist` → 501 stub. Setlist lands in Sprint 3.
- A per-week **invitation list** — `GET /api/invitations` is a 501 stub. There
  is no way to read a member's invitation status for a week. The roster
  status-badge acceptance criterion (Open / Pending / Confirmed / Declined /
  Conflict) is impossible without it.

**The one judgment call:** complete the existing `GET /api/invitations` 501 stub
into a minimal, week-scoped, roster-safe list endpoint (set_leader/admin), so the
roster can show real statuses. This is required to satisfy a named acceptance
criterion, the route stub already exists and is owned by no other open issue, and
it is a trivial read that mirrors `getOpenConflicts` exactly. **Scope guard:** do
NOT add write/mutation behavior, do NOT touch events/setlist backends, do NOT
build the actual invite-send flow — the roster's "+ Invite" button is a
non-functional placeholder for this issue (invite creation is #40, already
shipped as `POST /api/invitations`, but wiring the create UI is out of scope
here).

## Files to modify — backend (the one read endpoint)

### 1. `schemas/invitations.ts` (modify — add one schema)

Add, mirroring `getTeamAvailabilityQuerySchema` in `schemas/availability.ts`:

```ts
// GET /api/invitations?serviceWeekId= query (#48 Week View roster).
export const listInvitationsQuerySchema = z.object({
  serviceWeekId: z.string().uuid(),
});
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
```

### 2. `app/api/invitations/handler.ts` (modify — add `listInvitations`)

- Add a **roster-safe** response type and mapper. IMPORTANT: do NOT reuse
  `toInvitationResponse` — it exposes `responseToken`, which is the no-session
  credential and must never be sent to the roster UI.

```ts
export type WeekInvitation = {
  id: string;
  serviceWeekId: string;
  userId: string;
  roleNote: string | null;
  status: InvitationStatus;
  responseDeadline: string | null;
  createdAt: string;
};
// NOTE: intentionally omits response_token / denial_reason.
```

- Add `listInvitations(req: NextRequest, lookup?: UserLookup): Promise<Response>`:
  - `requireAuth` then `requireRole(ctx, ["admin", "set_leader"])` (copy the top
    of `getTeamAvailability` / `getOpenConflicts`).
  - Parse `req.nextUrl.searchParams` with `listInvitationsQuerySchema`; on
    failure `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
  - Get the Supabase JWT client exactly as the other handlers do.
  - Query `invitations` filtered by `.eq("service_week_id", serviceWeekId)` and
    `.eq("church_group_id", ctx.churchGroupId)`, `.order("created_at")`. Select
    only the `WeekInvitation` columns (`id, service_week_id, user_id, role_note,
    status, response_deadline, created_at`) — do NOT `select("*")`, to avoid
    pulling the token.
  - Return `ok({ invitations: rows.map(toWeekInvitation) })`.
  - Wrap in the same `try/catch` returning `ApiException` → `fail(...)` else
    `INTERNAL 500`, identical to the other handlers.

### 3. `app/api/invitations/route.ts` (modify — wire GET)

Replace the `GET` body (currently `notImplemented("GET /api/invitations")`) with
a call to `listInvitations(req)`. Leave the existing `POST` (→ `createInvitation`)
untouched. Import `listInvitations` alongside `createInvitation`.

## Files to create — frontend (the screen)

Follow the invite-response screen pattern exactly:
`app/(public)/invite/[token]/page.tsx` (server wrapper that awaits `params` and
renders a `"use client"` child) + `invite-response.tsx` (client component that
`fetch`es and renders) + `invite-response.module.css` (CSS module).

### 4. `app/(app)/week/[id]/page.tsx` (modify — replace the stub)

Server component. Mirror `app/(public)/invite/[token]/page.tsx`:

```tsx
export default async function WeekViewPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WeekView serviceWeekId={id} />;
}
```

### 5. `app/(app)/week/[id]/week-view.tsx` (new — `"use client"`)

Client component `WeekView({ serviceWeekId }: { serviceWeekId: string })`.
Structure and conventions copied from `invite-response.tsx` (useState/useEffect,
cancelled-flag load guard, `fetch` with `{ data }` envelope unwrap, graceful
error/permission states, local date/time formatting helpers). Use the shared
`Badge` (`components/ui/Badge`) and `Button` (`components/ui/Button`) components.

Data load (one `useEffect`, `Promise.all` of five `fetch`es, all read
`body.data`):

1. `GET /api/service-weeks/${serviceWeekId}` → header + service date.
2. `GET /api/service-weeks` → to compute prev/next week ids (see nav below).
3. `GET /api/church-group/members` → roster identities.
4. `GET /api/invitations?serviceWeekId=${serviceWeekId}` → `WeekInvitation[]`.
5. `GET /api/conflicts` → filter to `serviceWeekId === serviceWeekId`.
6. `GET /api/availability/team?startDate=${start}&endDate=${end}` → sidebar,
   where `[start, end]` is the 7-day window `serviceDate − 6 days ..
   serviceDate` inclusive (the lead-up week incl. service day). Do the date math
   in UTC via `new Date(\`${serviceDate}T00:00:00Z\`)` ± `n*86_400_000` then
   `.toISOString().slice(0,10)`, matching `schemas/availability.ts`'s UTC
   convention to avoid off-by-one.

State model (copy the `ViewState` union idea from `invite-response.tsx`):
`"loading" | "ready" | "forbidden" | "not-found" | "error"`.
- Any core fetch (1, 3, 4, 5) returning 403 → `"forbidden"` (this screen is
  Admin/Set Leader only; a member/guest must see an access message, not a crash).
- Fetch (1) returning 404 → `"not-found"`.
- Any other non-OK / thrown → `"error"`.
- The availability (6) and week-list (2) fetches are non-critical: if they fail,
  still render `"ready"` with the sidebar / nav degraded (empty), never block the
  whole screen on them.

Regions to render in `"ready"` (desktop-first two-column layout: main content +
collapsible right sidebar):

**Header** (AC 1): service date (format like `formatServiceDate` in
`invite-response.tsx`), `serviceWeek.title ?? "Untitled service"`, a publish
status `Badge`, and prev/next nav arrows.
- Publish badge: setlist publish state is not yet fetchable (setlist endpoint is
  501). Render a `Badge tone="neutral"` reading `Draft` with a
  `// TODO(Sprint 3 #64): drive from setlist status` comment. If
  `serviceWeek.isCancelled` is true, show a `Badge tone="danger"` reading
  `Cancelled` instead.
- Nav arrows: from the `GET /api/service-weeks` list (sorted by `serviceDate`),
  find the current week's index; the newer/older neighbors become next/prev,
  each a link to `/week/${neighborId}`. Disable an arrow when no neighbor exists.

**Roster grid** (AC 2): one slot per member from `GET /api/church-group/members`.
For each member, pick their "current" invitation = the `WeekInvitation` for that
`userId` with the max `createdAt`. Map to a status badge:

| Condition (checked in this order)                                   | Label     | `Badge` tone | Extra              |
| ------------------------------------------------------------------- | --------- | ------------ | ------------------ |
| current invitation's `id` ∈ conflicts for this week                 | Conflict  | `danger`     | —                  |
| current invitation `status === "accepted"`                          | Confirmed | `success`    | —                  |
| current invitation `status === "pending"`                           | Pending   | `warning`    | —                  |
| current invitation `status === "denied"`                            | Declined  | `neutral`    | —                  |
| no invitation, or only `withdrawn`/`expired`                        | Open      | `neutral`    | show "+ Invite" btn |

Each slot shows: an initials avatar (derive from `member.name` — first letter of
first + last whitespace-delimited token, uppercased; no image URL exists in
`DirectoryMember`), the member name, and the status `Badge`. The "+ Invite"
`Button` is a non-functional placeholder for now (renders, but no create flow —
see scope guard). Conflict badge MUST be visually red (use `tone="danger"`,
which is the red tone in `Badge.module.css`).

**Collapsible availability sidebar** (AC 3): a right-hand panel with a
collapse/expand toggle (`useState<boolean>`), rendering the team availability
grid from response (6): rows = members (`TeamAvailabilityMember.userId`, resolve
name via the roster members map), columns = the 7 dates in the window, each cell
green/red-ish from `entries[].isAvailable` for that date (no entry = unknown/
blank). Keep it simple — a CSS-grid table is fine.

**Events timeline** (AC 4): placeholder card. Events endpoint is 501 (#59). Show
a heading "Events", an empty-state line ("No events yet"), and a non-functional
"+ Add event" `Button`. Add `// TODO(#59): wire to GET/POST /api/events`.

**Setlist preview card** (AC 5): placeholder card. Setlist endpoint is 501
(Sprint 3). Show "Setlist", "0 songs", and a non-functional "Edit setlist"
`Button`. Add `// TODO(Sprint 3 #64): wire to setlist`.

### 6. `app/(app)/week/[id]/week-view.module.css` (new)

CSS module for the above. Copy the conventions of
`app/(public)/invite/[token]/invite-response.module.css` (plain CSS modules,
class-per-element). Desktop-first: a two-column layout (main + sidebar), a roster
grid, and the collapsible sidebar. No design system beyond the existing `Badge`
/ `Button` — keep styling minimal and functional.

## Edge cases the implementation must handle

- **Response-token leak:** the roster endpoint must NOT return `response_token`
  (or `denial_reason`). Select explicit columns; never `select("*")`. This is the
  single most important backend correctness point.
- **Role gating:** `/api/invitations` (list), `/api/availability/team`, and
  `/api/conflicts` are set_leader/admin-only and return 403 for members/guests.
  The page's `(app)` layout does NOT enforce role yet (see its TODO), so the
  client must handle 403 → `"forbidden"` view rather than rendering a broken grid.
- **Multiple invitations per member/week:** re-invites after a denial create
  multiple rows; always select the max-`createdAt` row as "current" so a stale
  `denied`/`withdrawn` row doesn't mask an active `pending`/`accepted` one.
- **Member with no invitation:** shows "Open" + "+ Invite", not a crash.
- **Conflict precedence:** an accepted-but-conflicted member reads "Conflict"
  (red), not "Confirmed".
- **Cancelled week:** header shows a `Cancelled` danger badge.
- **Empty roster / empty availability / no neighbor weeks:** render empty states,
  never throw.
- **Date math:** UTC-based (`T00:00:00Z`) for the availability window, matching
  the codebase, to avoid timezone off-by-one on the range bounds.
- **`{ data }` envelope:** every endpoint wraps its payload in `{ data }`
  (`types/api.ts`); unwrap `body.data` on each fetch, exactly like
  `invite-response.tsx`.

## Assumptions (non-blocking; a reviewer can override)

- "Slot" = one church-group member (all members are candidate slots). No
  position/instrument-slot model exists in the data yet.
- Avatar = generated initials (no avatar URL in `DirectoryMember`).
- Availability window = `serviceDate − 6 days .. serviceDate` (lead-up week).
- Publish badge shows a static `Draft` until the setlist endpoint lands.

## Tests

Two new files (Jest picks up `tests/unit/**/*.test.ts(x)` per `jest.config.js`):

- `tests/unit/app/api/invitations-list-route.test.ts` — copy the mocking style of
  `tests/unit/app/api/conflicts-route.test.ts` /
  `tests/unit/app/api/invitations-route.test.ts` (Supabase + auth mocks via
  `tests/support/api-auth.ts`). Cover: happy path returns week-scoped
  invitations; **the response never includes `responseToken`** (assert the key is
  absent); non-admin/set_leader → 403; missing/invalid `serviceWeekId` → 400.
- `tests/unit/app/week-view.test.tsx` — copy `tests/unit/app/invite-response.test.tsx`
  (`/** @jest-environment jsdom */`, `@testing-library/react`, mocked `global.fetch`
  keyed by URL). Cover: loading → ready; roster status mapping for each of Open /
  Pending / Confirmed / Declined / Conflict (conflict overrides accepted); the
  "+ Invite" button appears only on Open slots; 403 on a core fetch → forbidden
  view; sidebar collapse toggle.

## Patterns to copy (by file)

- Read endpoint w/ role gate + in-memory join: `app/api/conflicts/handler.ts`
  (`getOpenConflicts`) and `app/api/availability/team/handler.ts`.
- Query-schema shape: `getTeamAvailabilityQuerySchema` in `schemas/availability.ts`.
- Route GET wiring: `app/api/availability/team/route.ts`.
- Client screen (fetch + envelope + states + formatting): `invite-response.tsx`.
- Server page wrapper: `app/(public)/invite/[token]/page.tsx`.
- CSS module conventions: `invite-response.module.css`.
- UI atoms: `components/ui/Badge.tsx` (tones neutral/success/warning/danger),
  `components/ui/Button.tsx`.
- Endpoint unit test: `conflicts-route.test.ts`. Component test: `invite-response.test.tsx`.

## Verification before finishing (coder)

- `bun run typecheck`
- `bun run lint`
- `bun run test` (Jest; not the bare `bun test` runner)
