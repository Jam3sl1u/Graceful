# Changes — Issue #65: Build Member Week View screen

## Files created

- `app/api/service-weeks/[id]/member-view/handler.ts` — new
  `getMemberWeekView(req, id, lookup?)` handler exporting
  `MemberWeekViewResponse` (and its constituent types `MemberWeekEvent`,
  `MemberWeekSong`, `MemberWeekTeamMember`, `MemberWeekDocumentGroup`).
  Aggregates, via the caller's RLS-scoped Supabase client only (no
  service-role, no new RPC):
  - `requireAuth` + `requireRole(["admin", "set_leader", "member"])` (guest
    excluded — #72 is out of scope).
  - Service week lookup by `id` + `church_group_id` → 404 if missing.
  - Caller's own `invitations` row for the week, picking the latest by
    `created_at` when multiple exist → `confirmationStatus` (null if none).
  - `setlists` row for the week; only treated as present when
    `status === "published"` (drafts filtered by RLS anyway for members, but
    checked explicitly) → `setlist: null` otherwise. When published, reads
    `setlist_songs` ordered by `position`, then `songs` for the distinct song
    ids, building `effectiveKey = key_override ?? default_key`. Zero songs
    still yields `{ status: "published", songs: [] }`, not `null`.
  - `events` for the week ordered by `start_time asc`.
  - `event_attendees` for the week's event ids (query skipped entirely when
    there are no events, to avoid an empty `.in()`), used to compute each
    event's `assigned` flag (caller present as an attendee) and the distinct
    `teamUserIds`.
  - Team directory scoped to `teamUserIds` only (mirrors
    `getChurchGroupMembers`'s users/member_profiles/member_instruments/
    instruments assembly), sorted by name; no email/phone included.
  - Documents: only queried when there's a published setlist with songs;
    `song_documents` rows grouped by `song_id` with freshly minted
    `getDownloadUrl` per file (`@/lib/r2/client`, 30-min presigned GET); the
    whole block is wrapped in try/catch so an R2/query failure degrades to
    `documents: []` with a 200, not a 500.
  - Returns `ok<MemberWeekViewResponse>(...)`; catches `ApiException` →
    `fail(...)`, else 500 — same pattern as sibling handlers.

- `app/api/service-weeks/[id]/member-view/route.ts` — `GET` route wiring,
  copied from the `setlist` route's shape (await `params`, delegate to the
  handler).

- `app/(app)/member-week/[id]/member-week-view.tsx` (`"use client"`) — the
  screen component. `ViewState` machine (`loading | ready | forbidden |
  not-found | error`), single `useEffect` with a `cancelled` guard fetching
  `GET /api/service-weeks/:id/member-view` once. Renders, in order:
  - Header: title, `formatServiceDate`, confirmation `Badge` (mapped per
    spec: accepted→Confirmed/success, pending→Pending/warning,
    denied→Declined/neutral, withdrawn/expired→Not serving/neutral,
    null→Not invited/neutral) plus a `Cancelled`/danger badge when
    `isCancelled`.
  - Setlist section: not-released vs. zero-songs vs. song list w/
    title/artist/effectiveKey (`—` placeholder when null) — these are
    distinct states per the spec's edge cases 2 and 3.
  - Events section: only `assigned === true` events, each a `type="button"`
    row opening an in-page detail panel (`selectedEventId` state, no new
    route) showing name/type/start–end/notes, and a Maps link
    (`https://www.google.com/maps/search/?api=1&query=...`) only when
    `location` is non-empty.
  - Team section: avatar (`getInitials`), name, instruments joined by ", "
    (or "—" when empty); empty-team message when `team.length === 0`.
  - Documents section: per-song-group heading + file links (`downloadUrl`,
    opened in a new tab); empty-state message when none.
  - A disabled, inert floating "chat" button (`aria-label="Week chat (coming
    soon)"`, `disabled`, no `onClick`) as the Phase 2 placeholder.
  - Loading/forbidden/not-found/error branches mirror `week-view.tsx`'s
    `<main>` blocks (forbidden copy adjusted to a member context).

- `app/(app)/member-week/[id]/member-week-view.module.css` — mobile-first,
  single-column styles (container/header/card/date/error mirrored from
  `week-view.module.css`'s conventions, using the existing `--color-fg`/
  `--color-border`/`--color-bg` variables), plus new `.chatButton` (fixed
  bottom-right) and `.detail`/`.detailOverlay` (bottom-sheet-style event
  detail panel).

## Files modified

- `app/(app)/member-week/[id]/page.tsx` — replaced the "coming soon" stub
  with a server wrapper that awaits `params` and renders
  `<MemberWeekView serviceWeekId={id} />`, matching
  `app/(app)/week/[id]/page.tsx`'s shape exactly.

- `.pipeline/spec.md` — this was already updated in the working tree (issue
  #65's spec, produced by the Planning stage) before this Coding session
  started; included in this commit as part of the normal pipeline handoff.
  No further edits made to it by the Coding stage.

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — all 77 suites / 968 tests pass (no regressions; the two
  new test files the spec names for the Testing stage —
  `tests/unit/app/api/service-weeks-member-view-route.test.ts` and
  `tests/unit/app/member-week-view.test.tsx` — were intentionally not written
  here, per the pipeline contract that Testing writes and owns test files).

## What the Tester should focus on

- The 13 edge cases enumerated in `.pipeline/spec.md` under "Edge cases the
  implementation MUST handle", especially:
  - Published setlist with zero songs vs. no/draft setlist (must render two
    distinct messages).
  - Empty `event_attendees` for the week — handler must not issue an `.in()`
    query with an empty array (verify via a `from` spy on `event_attendees`
    not being called when `events` is empty).
  - `getDownloadUrl` throwing (simulate R2 misconfiguration) → endpoint still
    200 with `documents: []`.
  - Guest role → 403.
  - A member assigned to only some of the week's events — only those show in
    the Events section, but `team` reflects the full attendee set across all
    events.
  - Event with `location: null` → detail panel renders with no Maps link.
- The handler's per-table Supabase mock dispatch (many tables read across one
  request) — verify the `makeChain`-style test double the spec calls for
  handles `service_weeks`, `invitations`, `setlists`, `setlist_songs`,
  `songs`, `events`, `event_attendees`, `users`, `member_profiles`,
  `member_instruments`, `instruments`, `song_documents` all being queried
  from the same `getSupabaseClient(jwt)` instance.
