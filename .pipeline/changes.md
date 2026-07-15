# Changes — Issue #55: Add/remove/reorder setlist songs (BR-07 no duplicates)

## Summary

Implemented the three previously-stubbed setlist-editing endpoints per
`.pipeline/spec.md`, with no migrations and no scope creep.

## Files changed

- `schemas/setlists.ts` — replaced the `z.object({})` placeholder with
  `reorderSetlistSchema` (`{ songs: [{ songId, keyOverride? }] }`) and
  `addSetlistSongSchema` (`{ songId, keyOverride? }`), matching the style of
  `schemas/songs.ts`. Shape-only validation; BR-09 key membership is checked
  in the handler (422), shape errors are 400.

- `lib/supabase/types.ts` — added the missing `setlist_songs` row type and
  `Tables` entry (`id`, `setlist_id`, `song_id`, `position`, `key_override`,
  `notes`), modeled on the existing `setlists` entry: `id`/`key_override`/
  `notes` optional on Insert (DB-defaulted / nullable).

- `app/api/setlists/[id]/handler.ts` (new) — implements all three handlers,
  modeled on `app/api/service-weeks/[id]/setlist/handler.ts` and
  `app/api/songs/handler.ts` (`requireAuth` → `requireRole(["admin",
  "set_leader"])` → `getToken({ template: "supabase" })` (401 if null) →
  `getSupabaseClient` → queries → `ok`/`fail`, wrapped in the shared
  `try/catch` that maps `ApiException` and otherwise 500).
  - `toSetlistSongResponse` maps a `setlist_songs` row to the camelCase DTO
    (`id`, `setlistId`, `songId`, `position`, `keyOverride`, `notes`).
  - `loadEditableSetlist` — shared internal helper used by all three
    handlers: loads the parent `setlists` row scoped to `id` +
    `church_group_id` (giving correct 404 tenant semantics), and asserts
    `status === "draft"` (409 CONFLICT "Setlist is published. Unlock it
    before editing." otherwise). DB error → 500.
  - `loadOrderedSongs` — shared helper that re-selects all `setlist_songs`
    rows for a setlist ordered by `position` asc, used to build the response
    at the end of every handler.
  - `reorderSetlist` (PUT, 200): parses body → per-entry BR-09 check (422) →
    editable-setlist guard → rejects duplicate `songId`s in the body (400) →
    loads current `setlist_songs` and requires the body's songId set to
    exactly equal the setlist's current songId set (400 "Song set does not
    match the setlist" otherwise — add/remove is POST/DELETE-only) → updates
    each row's `position` (1-indexed from array order) and `key_override`
    (matched by `song_id`, scoped to `setlist_id`) → returns the freshly
    reloaded, position-ordered list.
  - `addSetlistSong` (POST, 201): parses body → BR-09 check (422) →
    editable-setlist guard → verifies the song exists in the caller's group
    (404 "Song not found" otherwise, preventing cross-tenant adds) → BR-07
    duplicate pre-check via `.eq("setlist_id", id).eq("song_id",
    songId).maybeSingle()` (409 CONFLICT "That song is already in the
    setlist." otherwise) → computes next position as current-count + 1 →
    inserts, with a race backstop that maps a Postgres unique-violation
    (`code === "23505"`) to the same 409 rather than a generic 500 → returns
    the reloaded list.
  - `removeSetlistSong` (DELETE, 200): editable-setlist guard → deletes the
    row scoped to `setlist_id` + `song_id`, chaining `.select("id")` after
    `.delete()` so a missing/foreign row is detected (404 "Song not found in
    setlist" if nothing was deleted) → recompacts positions by re-selecting
    remaining rows ordered by `position` and rewriting any row whose
    `position` no longer matches its 1-indexed slot → returns the reloaded
    list (`{ songs: [] }` for an emptied setlist).

- `app/api/setlists/[id]/route.ts` — replaced the `PUT` 501 stub with a thin
  wrapper that awaits `params` and calls `reorderSetlist`.

- `app/api/setlists/[id]/songs/route.ts` — replaced the `POST` 501 stub with
  a thin wrapper calling `addSetlistSong`.

- `app/api/setlists/[id]/songs/[songId]/route.ts` — replaced the `DELETE`
  501 stub with a thin wrapper calling `removeSetlistSong`.

## Not changed (per spec's explicit non-scope)

- No migrations added or modified — `setlists`/`setlist_songs` DB schema,
  constraints, and RLS are unchanged.
- `notes` on `setlist_songs` is not settable through these endpoints.
- `setlists.updated_at` is not bumped by these mutations.
- No publish/unlock logic (issue #56) — mutations are gated on
  `status === 'draft'` only, per the spec's documented non-blocking decision.

## Verification

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` — clean, no errors.
- `bun run test` — all 58 suites / 729 tests pass (no test file for the new
  handler exists yet; per the pipeline contract, writing/independently
  verifying tests for this endpoint is the Testing stage's job, not
  Coding's).

## What the Tester should focus on

- Role gating: `member`/`guest` → 403 before any DB call, for all three
  endpoints; `admin`/`set_leader` allowed.
- Auth gating: no Clerk user or no Supabase JWT → 401, before any DB call
  (role check happens first per the songs-handler ordering convention, so a
  forbidden role never reaches `getToken`).
- Tenant scoping / 404: setlist id missing or belonging to another
  `church_group_id` → 404 for all three endpoints.
- Published-setlist guard: `status = 'published'` → 409 CONFLICT for all
  three endpoints (PUT, POST, DELETE).
- PUT: 400 on malformed JSON, on a body songId set that doesn't exactly match
  the setlist's current songs (both missing an existing song and containing
  an extra one), and on duplicate songIds within the body; 422 on a
  shape-valid but BR-09-invalid `keyOverride`; verify positions end up
  exactly `1..N` matching array order and that `key_override` is set
  per-entry (including explicit `null` clearing an override).
- POST: 404 when `songId` doesn't exist in the caller's group catalog; 409
  BR-07 when the song is already in the setlist; verify the new row lands at
  `position = count + 1`; 422 on invalid `keyOverride`.
- DELETE: 404 when the `songId` isn't in the setlist (or belongs to another
  tenant's setlist via a mismatched `setlist_id`); verify recompaction
  produces contiguous `1..N` positions after removing a song from the
  middle, and `{ songs: [] }` after removing the last song.
- 500 mapping for a Supabase error at each query/insert/update/delete step.
- Follow the existing mock/test harness pattern in
  `tests/unit/app/api/songs-route.test.ts` (chainable Supabase mock,
  `makeLookup(role)`, `setUpAuth`) — note this handler's mock will need
  `.delete()`, `.update()`, and `.maybeSingle()` chain support in addition to
  what that file already covers.
