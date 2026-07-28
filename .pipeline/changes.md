# Changes — Issue #64: Setlist Builder screen

## Backend

- `app/api/setlists/[id]/handler.ts`
  - Added `getSetlistWithSongs(req, id, lookup?)`: `GET /api/setlists/:id`
    handler. `requireAuth` + `requireRole(["admin", "set_leader"])`, loads the
    setlist tenant-scoped (`church_group_id` match), 404s if missing/other
    tenant, 500 on DB error, reuses the existing private `loadSongResponses`
    helper for the ordered songs, and returns
    `{ setlist: toSetlistResponse(data), songs }` for both draft and
    published setlists (client needs status to render the locked state).
  - `reorderSetlist`'s per-song update loop now conditionally includes
    `notes` in the Supabase update payload only when `entry.notes !== undefined`
    (i.e. the client actually sent it), so existing reorder callers that omit
    notes do not wipe them. `null` clears notes, a string sets them.
- `app/api/setlists/[id]/route.ts` — added `export async function GET` wired
  to `getSetlistWithSongs`; `PUT` export unchanged.
- `schemas/setlists.ts` — `reorderSetlistSchema`'s per-song object gained an
  optional `notes: z.string().trim().max(1000).nullish()` field.
  `addSetlistSongSchema` left unchanged (notes are only added via PUT after a
  song is in the setlist).
- `schemas/songs.ts` — added `export const SONG_KEY_OPTIONS = ASCII_SONG_KEYS;`
  (the ordered 17-key ASCII list) for the frontend key `<select>`. Left
  `VALID_SONG_KEYS` / `isValidSongKey` untouched.

## Frontend

- `app/(app)/setlists/[id]/page.tsx` — replaced the stub with a server
  wrapper (mirrors `app/(app)/week/[id]/page.tsx`) that awaits `params` and
  renders `<SetlistBuilder setlistId={id} />`.
- `app/(app)/setlists/[id]/setlist-builder.tsx` (new, `"use client"`) — the
  two-panel Setlist Builder screen:
  - Loads `GET /api/setlists/:id` and `GET /api/songs` in parallel on mount
    (`cancelled` guard). Setlist 403/404/other-failure → `forbidden` /
    `not-found` / `error` views; catalog 403 → `forbidden`, other catalog
    failure degrades to an empty catalog (search still renders, non-fatal).
  - Left panel: client-side substring search (title/artist, case-insensitive)
    over the loaded catalog, an Add button per result (disabled once already
    in the setlist; 409 → inline "already in the setlist" message), and a
    quick-add form (title required, artist + `SONG_KEY_OPTIONS` key select
    optional) shown when the search term is non-empty and no catalog row
    matches — submits `POST /api/songs` then immediately
    `POST /api/setlists/:id/songs` to add it.
  - Right panel: ordered rows (position, title/artist resolved via a
    `catalogById` map, key `<select>` from `SONG_KEY_OPTIONS`, a notes text
    input persisted on blur, a native HTML5 drag handle, and Remove). Key
    changes, drag reorders, and notes-blur all persist through a single
    `persistSongs` helper that PUTs the **full** current song set
    (`{ songId, keyOverride, notes }[]`) to `PUT /api/setlists/:id` in
    display order; on failure it shows an inline error and resyncs from
    `GET /api/setlists/:id`.
  - Bottom bar: song count + a Publish button (never disabled at zero songs)
    that opens a `components/ui/Modal.tsx` confirmation (explicit "no songs
    yet" copy when empty) before calling `POST /api/setlists/:id/publish`
    (409 → "Setlist is already published.").
  - Published/locked state: when `meta.status === "published"`, all editing
    controls are disabled and a banner with an "Unlock to edit" button calls
    `POST /api/setlists/:id/unlock`.
  - No drag-and-drop dependency added — uses native `draggable` /
    `onDragStart` / `onDragOver` / `onDrop` on the row `<li>` elements
    (`DragEvent<HTMLLIElement>`).
- `app/(app)/setlists/[id]/setlist-builder.module.css` (new) — desktop-first
  two-column layout (search panel / setlist panel), a fixed bottom bar, and
  row styling, following `week-view.module.css`'s `.container` / `var(--color-*)`
  conventions. No global style changes.

### Follow-up fix (post-review)

- `app/(app)/setlists/[id]/setlist-builder.tsx` — the initial version left
  `quickAddTitle` as an independent `useState("")`, so the quick-add form's
  Title field rendered empty instead of prefilled with the search term
  (spec requirement, flagged by Review as the sole blocker).

  A first attempted fix (`wasQuickAddShownRef` + a `useEffect` that seeded
  `quickAddTitle` only on the hidden→shown transition) was itself found
  broken on re-review: the ref latched `true` after the *first* no-match
  character, so continued typing in the search box never re-synced the
  title — a user typing "Totally New Song" letter-by-letter ended up
  submitting `title: "To"`, silently writing a junk row into the shared
  song catalog (worse than the original bug, which at least blocked submit
  via `required`).

  Corrected fix: a `quickAddTitleDirty` boolean state, set `true` in the
  Title field's own `onChange` (i.e. the user has independently edited it).
  The seeding `useEffect` (keyed on `[searchTerm, catalog, quickAddTitleDirty]`)
  now syncs `quickAddTitle` to `searchTerm` on every change to `searchTerm`
  while the quick-add form is shown **and** the title hasn't been
  independently edited, and resets `quickAddTitleDirty` back to `false`
  whenever the form goes hidden (so the next time it reappears, it seeds
  fresh from whatever the new search term is). This keeps the title synced
  through continued typing, while still preserving a user's manual edit
  once they've made one.

### Non-blocking cleanup (post-SHIP)

The final review that SHIPped the corrected fix above also flagged two
non-blocking items, both since addressed:

- **Stuck dirty flag**: in `handleQuickAdd`, if `POST /api/songs` succeeds
  but the follow-up `handleAdd` (add-to-setlist) call fails, `quickAddTitle`
  was still unconditionally cleared to `""`, but `quickAddTitleDirty` was
  left `true` — so if the search term still didn't match anything (e.g. the
  created song's title diverged from the search term), the title field was
  stuck blank with no way to re-sync short of the user retyping the search
  box from scratch. Fixed by resetting `quickAddTitleDirty` to `false`
  alongside the other field resets in `handleQuickAdd`, so the seeding
  effect re-populates the title from the current search term on its next
  run. Covered by a new test: "quick-add flow: a failed add-to-setlist
  after a successful song creation still leaves the title resyncable (not
  stuck blank)".
- **Duplicated match predicate**: the "does this term match the catalog"
  substring rule was independently written out twice — once in the seeding
  `useEffect`, once in the render-time `filteredCatalog` computation —
  risking drift between the two. Extracted into a single module-level
  `filterCatalog(catalog, term)` helper used by both.

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean (one fixup needed: the drag handlers are
  attached to `<li>` rows, so the `DragEvent` generic had to be
  `HTMLLIElement`, not `HTMLDivElement`).
- `bun run test` — full suite: 77 suites / 968 tests, all passing, including
  the three existing setlist route tests the spec calls out by name
  (`setlists-songs-route.test.ts`, `setlists-key-override.test.ts`,
  `setlists-publish-route.test.ts` — 74 tests, all green, run in isolation
  too). No new tests were added in this stage (Coding implements only; the
  Testing stage should cover the new `GET` endpoint, the notes-persistence
  guard, and the new UI).

## What the Tester should focus on

- New `GET /api/setlists/:id`: tenant scoping (404 for other-tenant/missing,
  not 403 — never leak existence), role gating (403 for non set_leader/admin),
  and that it returns songs for **both** draft and published setlists.
- The `notes` guard in `reorderSetlist`: a PUT that omits `notes` on an entry
  must leave that song's existing `notes` column untouched; `notes: null`
  clears it; a string sets it. Confirm the existing reorder/key-override
  tests (which omit `notes`) still pass unmodified — they do (verified above).
- Frontend: quick-add flow (create song → auto-add to setlist), duplicate-add
  409 handling, key-override "equals default → null" logic (including a song
  whose `defaultKey` is `null`), notes persist-on-blur (not per keystroke),
  drag reorder, the zero-songs Publish confirmation copy, and the
  published/locked state disabling all editing controls with a working
  Unlock affordance.
- Out of scope (left untouched, per spec): Spotify enrichment, the
  `TODO(#64)` "Edit setlist" button wiring in `week-view.tsx`, and the shape
  of `toSetlistSongResponse` / `SetlistSongResponse` / `addSetlistSongSchema`.
