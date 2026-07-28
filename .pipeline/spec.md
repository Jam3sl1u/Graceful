# Spec — Issue #65: Build Member Week View screen

## OPEN QUESTIONS

None blocking. One design decision is called out under **Decisions & assumptions**
(how the confirmed team is sourced for a member) — it is resolved with an
RLS-compatible approach and does not require a human to proceed. If a reviewer
disagrees with that sourcing, it is a follow-up, not a blocker for this screen.

## Goal

Turn the stub at `app/(app)/member-week/[id]/page.tsx` ("coming soon") into the
Member Week View: a mobile-first screen showing, for the signed-in member and a
given service week, the header (date + their confirmation status), setlist,
their assigned events (each tappable to a detail view with a Maps link), the
confirmed team with instruments, and this week's song documents (chord charts /
sheet music) opened via signed URL.

PRD ref: Phase 1 PRD §13 Screen 3.

## Current state (verified)

- `app/(app)/member-week/[id]/page.tsx` is a stub returning an `<h1>`.
- There is **no** member-facing endpoint that returns setlist *songs*
  (`GET /api/setlists/:id` is PUT-only; `.../songs` is POST-only). Members
  therefore currently have no way to read songs + keys.
- `GET /api/invitations?serviceWeekId=` is `set_leader`/`admin` only
  (`app/api/invitations/handler.ts` `listInvitations`), so a member cannot read
  the roster or others' confirmation via it.
- RLS (`supabase/migrations/20260704000001_rls_policies.sql`) for a `member`:
  - `service_weeks`, `events`, `event_attendees`, `songs`, `song_documents`,
    `users`, `member_profiles`, `member_instruments`, `instruments` — **tenant
    readable** (whole church group).
  - `setlists` / `setlist_songs` — readable **only when the setlist is
    `published`** (drafts filtered out for members).
  - `invitations` — a member can read **only their own** rows
    (`invitations_select_own`); cannot read other members' invitations.
- `accept_invitation` RPC inserts one `event_attendees` row per existing week
  event on accept (idempotent) — so `event_attendees` for a week's events is the
  member-visible source of "who is serving this week".

Because a member cannot read other members' `invitations` under RLS, the Team
section and "is anyone else confirmed" cannot be derived from `invitations`. It
is instead derived from `event_attendees` (which members *can* read). See
Decisions.

## Approach

Add **one** member-facing aggregate endpoint that returns the entire screen
payload in a single call, then build the screen as a server wrapper + `"use
client"` component (mirroring `app/(app)/week/[id]/page.tsx` +
`week-view.tsx`). The endpoint does all reads through the caller's RLS-scoped
Supabase client — **no new RPC, no RLS changes, no service-role usage**
(service-role is banned in `app/`).

## Files to create / modify

### 1. CREATE `app/api/service-weeks/[id]/member-view/handler.ts`

Pattern to copy: `app/api/service-weeks/[id]/setlist/handler.ts` (auth + JWT +
`getSupabaseClient` boilerplate) and `app/api/church-group/members/handler.ts`
(directory / instrument assembly), plus `app/api/songs/[id]/documents/handler.ts`
`toSongDocumentResponse` for signed-URL minting.

Export the response type and the handler:

```ts
import type { EventType, InvitationStatus, VocalCapability } from "@/types/domain";

export type MemberWeekEvent = {
  id: string;
  type: EventType;
  name: string;
  location: string | null;
  startTime: string;   // events.start_time
  endTime: string;     // events.end_time
  notes: string | null;
  assigned: boolean;   // caller is in event_attendees for this event
};

export type MemberWeekSong = {
  songId: string;
  title: string;
  artist: string | null;
  position: number;             // setlist_songs.position
  effectiveKey: string | null;  // key_override ?? songs.default_key
};

export type MemberWeekTeamMember = {
  userId: string;
  name: string;
  vocalCapability: VocalCapability;      // 'none' when no member_profile
  instruments: { id: string; name: string }[];
};

export type MemberWeekDocumentGroup = {
  songId: string;
  songTitle: string;
  files: {
    id: string;
    name: string;
    fileType: string;
    fileSizeBytes: number;
    downloadUrl: string;   // presigned GET, 30-min expiry (lib/r2/client getDownloadUrl)
  }[];
};

export type MemberWeekViewResponse = {
  serviceWeek: {
    id: string;
    serviceDate: string;   // service_weeks.service_date (YYYY-MM-DD)
    title: string | null;
    isCancelled: boolean;
  };
  confirmationStatus: InvitationStatus | null; // caller's own invitation status for this week; null if none
  setlist: { status: "published"; songs: MemberWeekSong[] } | null; // null = draft or no setlist
  events: MemberWeekEvent[];   // ALL events of the week (assigned flag per event), ordered by startTime asc
  team: MemberWeekTeamMember[];
  documents: MemberWeekDocumentGroup[];
};

export async function getMemberWeekView(
  req: NextRequest,
  id: string,               // service_week_id
  lookup?: UserLookup,
): Promise<Response>;
```
`entry.notes === undefined` (field absent) → leave the column as-is; `null` → clear it; string → set it. Do not change any other reorder behavior (membership check, position rewrite, response).

Handler logic (all queries via `getSupabaseClient(jwt)` = caller RLS):

1. `requireAuth(req, lookup)`, then `requireRole(ctx, ["admin", "set_leader", "member"])`
   — guests are excluded (guest variant is #72, out of scope). Get the supabase
   JWT exactly like the sibling handlers (401 if no JWT).
2. Load the service week (`service_weeks` where `id` + `church_group_id`,
   `maybeSingle`). If missing → `fail("Not found", ErrorCode.NOT_FOUND, 404)`.
   Map to `{ id, serviceDate: row.service_date, title, isCancelled: row.is_cancelled }`.
3. Caller's own invitation: `invitations` select `status, created_at` where
   `service_week_id = id` and `user_id = ctx.userId`. If multiple rows, pick the
   latest by `created_at` (re-invite safety — mirror `getCurrentInvitation` in
   `week-view.tsx`). `confirmationStatus` = that status, else `null`.
4. Setlist: `setlists` where `service_week_id = id` + `church_group_id`,
   `maybeSingle`. RLS returns it only if `published` for members.
   - If no row **or** `status !== "published"` → `setlist = null`.
   - If `published` → read `setlist_songs` where `setlist_id` ordered by
     `position asc`; collect distinct `song_id`s; read `songs` (`id, title,
     artist, default_key`) for those ids; build `MemberWeekSong[]` with
     `effectiveKey = key_override ?? default_key`. Zero songs → `songs: []`
     (still `setlist: { status: "published", songs: [] }`, NOT null).
5. Events: `events` where `service_week_id = id` + `church_group_id` ordered by
   `start_time asc`.
6. Attendees: `event_attendees` where `event_id in (weekEventIds)` selecting
   `event_id, user_id`. Build:
   - per-event `assigned = attendees.some(a => a.event_id === e.id && a.user_id === ctx.userId)`.
   - `teamUserIds` = distinct `user_id` across those attendee rows.
   Guard the `.in(...)` against an empty id list (skip the query, treat as `[]`)
   to avoid a malformed query.
7. Team directory (only if `teamUserIds` non-empty): mirror
   `getChurchGroupMembers` assembly but scoped to `teamUserIds`:
   `users` (`id, name`, `church_group_id = ctx.churchGroupId`, `anonymized_at is null`,
   `id in teamUserIds`), `member_profiles` (`id, user_id, vocal_capability`),
   `member_instruments` (`member_profile_id, instrument_id`), `instruments`
   (`id, name`, group-scoped). Produce `MemberWeekTeamMember[]`. Sort by `name`
   ascending for stable output. Do **not** include email/phone.
8. Documents (only if the published setlist has songs): `song_documents` where
   `song_id in (weekSongIds)` + `church_group_id`, selecting
   `id, song_id, name, file_key, file_type, file_size_bytes`, ordered by
   `created_at asc`. Mint `downloadUrl` per row via `getDownloadUrl(file_key)`
   (import from `@/lib/r2/client`). Group by `song_id`, attaching `songTitle`
   from step 4's song map; only include groups that have ≥1 file. **Best-effort**:
   wrap the whole documents block in try/catch — on any R2/query error, set
   `documents = []` and still return 200 (documents are one non-critical section;
   an R2 outage must not 500 the whole screen).
9. Return `ok<MemberWeekViewResponse>({ ... })`. Catch `ApiException` →
   `fail(err.message, err.code, err.status)`, else 500 — same as siblings.

Envelope: use `ok(...)` / `fail(...)` from `@/lib/api/response`; the success body
is `{ data: MemberWeekViewResponse }`.

### 2. CREATE `app/api/service-weeks/[id]/member-view/route.ts`

Copy `app/api/service-weeks/[id]/setlist/route.ts` shape, GET only:

```ts
import { NextRequest } from "next/server";
import { getMemberWeekView } from "./handler";

## Frontend

### `app/(app)/setlists/[id]/page.tsx` (replace the stub)

Server wrapper mirroring `app/(app)/week/[id]/page.tsx`:
```tsx
import SetlistBuilder from "./setlist-builder";
export default async function SetlistBuilderPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return getMemberWeekView(req, id);
}
```

### 3. REWRITE `app/(app)/member-week/[id]/page.tsx`

Copy `app/(app)/week/[id]/page.tsx` exactly (server wrapper awaiting `params`,
rendering the client child):

```tsx
import MemberWeekView from "./member-week-view";

export default async function MemberWeekViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MemberWeekView serviceWeekId={id} />;
}
```

### 4. CREATE `app/(app)/member-week/[id]/member-week-view.tsx`  (`"use client"`)

Pattern to copy: `app/(app)/week/[id]/week-view.tsx` — same `ViewState`
machine (`"loading" | "ready" | "forbidden" | "not-found" | "error"`), same
`useEffect` + `cancelled` guard, same `formatServiceDate` / `getInitials`
helpers, same envelope reads (`body.data.X`).

Props: `{ serviceWeekId: string }`.

Single fetch: `GET /api/service-weeks/${serviceWeekId}/member-view`.
- 404 → `not-found`; 403 → `forbidden`; other non-ok → `error`; on network
  throw → `error`. On ok, store the `data` payload and set `ready`.

Render (mobile-first, single column), sections in this order:

- **Header**: `formatServiceDate(serviceWeek.serviceDate)` and the title
  (`serviceWeek.title ?? "Untitled service"`). Confirmation status shown with
  `Badge` (`@/components/ui/Badge`): map `confirmationStatus` →
  `accepted`→"Confirmed"/`success`; `pending`→"Pending"/`warning`;
  `denied`→"Declined"/`neutral`; `withdrawn`/`expired`→"Not serving"/`neutral`;
  `null`→"Not invited"/`neutral`. If `serviceWeek.isCancelled`, also render a
  `Badge tone="danger"`>Cancelled (copy the cancelled treatment from
  `week-view.tsx`).
- **Setlist section** (`<h2>Setlist</h2>`):
  - `setlist === null` → paragraph `Setlist not yet released`.
  - published with `songs.length === 0` → `No songs added yet` (distinct from
    the not-released message).
  - published with songs → ordered list, each row `title` (+ `artist` if
    present) and `effectiveKey` (show a "—" / "no key" when `effectiveKey`
    is null).
- **Events section** (`<h2>Events</h2>`): render events where `assigned === true`.
  If none assigned → `You're not assigned to any events this week`. Each event is
  a tappable button/row (`type="button"`) showing name + start time; clicking sets
  a `selectedEventId` in state to open the detail view. Format times from the
  ISO `startTime`/`endTime` with `toLocaleString` (date + time).
  - **Event detail view**: an in-page panel/modal (no new route) rendered when
    `selectedEventId` is set, showing name, type, start–end, notes, location, and
    — only when `location` is non-empty — a **Maps link**:
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`
    rendered as an `<a target="_blank" rel="noopener noreferrer">Open in Maps</a>`.
    Include a close control that clears `selectedEventId`.
- **Team section** (`<h2>Team</h2>`): list `team` members; each shows
  `getInitials(name)` avatar, `name`, and their instruments (join
  `instruments.map(i => i.name)` with ", "; when empty show a muted "—"). If
  `team.length === 0` → `No confirmed team yet`.
- **Documents section** (`<h2>Documents</h2>`): for each group in `documents`,
  a subheading `songTitle` and its `files` as `<a href={file.downloadUrl}
  target="_blank" rel="noopener noreferrer">{file.name}</a>`. If
  `documents.length === 0` → `No documents for this week's songs`.
- **Floating chat button** (Phase 2 placeholder): a visually-present floating
  button (fixed position, mobile-first) that is inert — render it but give it no
  working `onClick` (omit the handler or a no-op). Add
  `aria-label="Week chat (coming soon)"` and mark it `disabled` so it clearly
  does nothing yet. Do NOT wire any chat behavior.

Loading / forbidden / not-found / error branches: copy the corresponding
`<main>` blocks from `week-view.tsx` (adjust the forbidden copy to a member
context, e.g. "You don't have access to this week.").

### 5. CREATE `app/(app)/member-week/[id]/member-week-view.module.css`

Mobile-first. Copy the container/card/header conventions from
`app/(app)/week/[id]/week-view.module.css` (`.container`, `.header`, `.card`,
`.date`, `.error`). Single-column layout (no sidebar). Add a `.chatButton`
(fixed bottom-right floating) and `.detail`/`.detailOverlay` for the event
detail panel. Use existing CSS variables (e.g. `var(--color-fg)`).

## Tests (for the Testing stage — named here for the coder's awareness)

- Handler: `tests/unit/app/api/service-weeks-member-view-route.test.ts`.
  Mirror `tests/unit/app/api/song-documents-route.test.ts`:
  `jest.mock` `@clerk/nextjs/server`, `@/lib/supabase/client`, `@/lib/r2/client`;
  use the `makeChain` / `makeLookup` / `setUpAuth` helpers. `getSupabaseClient`
  should return a `from(table)` dispatcher returning a per-table chain so the
  many reads can be stubbed by table name.
- Component: `tests/unit/app/member-week-view.test.tsx`. Mirror
  `tests/unit/app/week-view.test.tsx` (`/** @jest-environment jsdom */`, mocked
  `fetch` keyed by URL, `jsonResponse` helper).

## Edge cases the implementation MUST handle

1. Service week missing / other tenant → endpoint 404 → screen `not-found`.
2. No setlist OR draft setlist → `setlist: null` → "Setlist not yet released".
3. Published setlist with **zero** songs → `setlist: { status:"published",
   songs: [] }` → "No songs added yet" (must NOT show the not-released message).
4. `effectiveKey` is `key_override ?? default_key`; both may be null → render a
   neutral placeholder, not "null".
5. Week with no events → `events: []`; Events section empty state; `team` may
   also be empty.
6. Member assigned to some but not all events → only `assigned === true` events
   show; the header/team still reflect the full week's attendees.
7. Event with `location === null` (or empty) → detail view shows NO Maps link.
8. Empty `event_attendees` id set → skip the `.in()` queries; do not issue a
   query with an empty array.
9. Documents: R2 not configured / `getDownloadUrl` throws → `documents: []`,
   endpoint still 200 (best-effort; screen shows the empty state).
10. Member has no invitation for the week → `confirmationStatus: null` →
    "Not invited" badge; screen still renders (viewing is not gated on
    confirmation).
11. Cancelled week → header shows the Cancelled badge.
12. Guest role calling the endpoint → 403 (requireRole excludes guest).
13. Signed download URLs expire in 30 min — always freshly minted per request
    (never cached); do not store `file_key` in the response.

## Decisions & assumptions

- **Confirmed team is sourced from `event_attendees`, not `invitations`.**
  A `member` cannot read other members' `invitations` under RLS, but *can* read
  `event_attendees` for the group's events. `accept_invitation` auto-inserts an
  attendee row per week event on accept, so attendees of the week's events are
  the member-visible confirmed serving roster. Known limitation: a member
  confirmed for a week that has **no events yet** won't appear in `team` until
  events exist / they're assigned. Acceptable for Phase 1 and avoids any
  RLS/RPC change in a screen-scoped issue. (Strict accepted-invitation semantics
  for a member would need a `SECURITY DEFINER` RPC — out of scope here.)
- **One aggregate endpoint** rather than several member-facing GETs, to keep the
  client to a single fetch and localize the read logic. It uses only the
  caller's RLS-scoped client (no service-role, no new RPC, no RLS migration).
- **Event detail is in-page** (selected-event panel/modal), not a separate
  route — satisfies "tappable into a detail view with a Maps link" without new
  routing surface.
- **Scope guardrails**: do not add app nav/links to this screen (AppShell nav is
  a separate TODO); do not change existing endpoints' RBAC; do not implement
  chat; do not build a guest variant (#72).

## Verification before finishing (Coding stage)

Run `bun run lint`, `bun run typecheck`, and `bun run test`. All must pass.
</content>
