# Changes — Issue #57: Per-song key override validation & default-vs-override distinction (BR-09)

## Summary

Most of #57 was already implemented by #55 (BR-09 handler-level key validation
returning 422, and overrides never touching `songs.default_key`). The only
missing piece — AC #4, letting clients distinguish "using the song's default
key" from "overridden this week" — is now implemented.

## Files changed

### `app/api/setlists/[id]/handler.ts`

- Extended `SetlistSongResponse` with three derived fields: `defaultKey`
  (the song's catalog `default_key`), `effectiveKey` (`keyOverride ?? defaultKey`),
  and `isOverridden` (`keyOverride != null`).
- Changed `toSetlistSongResponse(row, defaultKey)` to take the song's default
  key as a second argument and compute the derived fields. `isOverridden` is
  derived strictly from `key_override != null`, never from comparing values
  (so a leader-set override equal to the default key still shows
  `isOverridden: true`, per spec edge case #3).
- Added a new `loadSongResponses(supabase, setlistId)` helper: loads the
  ordered `setlist_songs` rows (via the existing `loadOrderedSongs`), collects
  the distinct `song_id`s, does one `songs.select("id, default_key").in("id", ...)`
  query to build a `Map<songId, defaultKey>`, and maps each row through
  `toSetlistSongResponse`. Skips the `songs` query entirely when there are no
  rows (empty-setlist edge case), returning `{ songs: [] }`.
- Routed all three handlers (`reorderSetlist`, `addSetlistSong`,
  `removeSetlistSong`) through `loadSongResponses` instead of
  `loadOrderedSongs(...).map(toSetlistSongResponse)`, preserving existing
  status codes (201 for add, default 200 elsewhere) and the existing 500
  INTERNAL mapping on query error.
- `loadOrderedSongs` is unchanged and still used internally.
- No change to BR-09 validation (`isValidSongKey` checks in `reorderSetlist`
  and `addSetlistSong`), no change to insert/update payload logic (override
  is never copied into `default_key`, and `default_key` is never written by
  these handlers), no schema/migration changes.

### `tests/unit/app/api/setlists-songs-route.test.ts` (maintenance, not new coverage)

Updated to keep this existing suite green against the response shape change:

- Added `default_key: string | null` to the fake `SongsRow` type and gave each
  fixture song a distinct value (song-1 `"C"`, song-2 `"D"`, song-3 `"E"`,
  song-4/other-tenant `"F"`).
- Extended the fake `makeSelectChain` with an `.in(field, values)` method
  (pushes a predicate matching rows whose `field` is in `values`; applied
  alongside the existing `eq` filters before `order`), since
  `loadSongResponses` calls `.from("songs").select("id, default_key").in("id", songIds)`.
- Updated the three happy-path expected-response assertions (reorder, add,
  remove) to include `defaultKey`, `effectiveKey`, `isOverridden` consistent
  with each row's `key_override` and its song's `default_key`.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run test tests/unit/app/api/setlists-songs-route.test.ts` — 35/35 passing.
- `bun run test` (full suite) — 66 suites / 830 tests passing.

## What the Tester should focus on

- Independent coverage of BR-09 (AC #2): malformed body -> 400, shape-valid
  but non-musical `keyOverride` -> 422, for both `PUT /api/setlists/:id` and
  `POST /api/setlists/:id/songs`. This was already implemented pre-#57 but the
  spec calls for independent Tester verification.
- AC #4 response shape across all three endpoints: `key_override: null` ->
  `isOverridden: false`, `effectiveKey === defaultKey`; non-null override ->
  `isOverridden: true`, `effectiveKey === keyOverride` (including the case
  where the override happens to equal the default — must still be
  `isOverridden: true`).
- Edge case: song with `default_key = null` and no override -> `defaultKey`,
  `effectiveKey` both `null`, `isOverridden: false`.
- Edge case: removing the last song in a setlist -> `{ songs: [] }`, no
  `songs` table query attempted (the `songIds.length > 0` guard).
- Confirm `songs.default_key` is never mutated by any of these three handlers
  (AC #3) — e.g. an override should not leak into the song catalog.
