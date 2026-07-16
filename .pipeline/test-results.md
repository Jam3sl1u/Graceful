# Test Results — Issue #57: Per-song key override validation & default-vs-override distinction (BR-09)

This overwrites the stale `test-results.md` for issue #61 that was still sitting at
this path (per AGENTS.md, `.pipeline/` files reflect only the most recent run).

## Verdict: PASS

## Verification performed

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run test tests/unit/app/api/setlists-songs-route.test.ts` (Coder's maintained
  suite) — 35/35 passing, independently re-run.
- `bun run test tests/unit/app/api/setlists-key-override.test.ts` (new, written this
  stage) — 16/16 passing.
- `bun run test` (full suite) — **67 suites / 846 tests passing** (66 suites / 830 tests
  baseline from the coder's work, plus 1 new suite / 16 new tests added by this stage).
  No regressions.

## Independent code read

Read `app/api/setlists/[id]/handler.ts` in full against `.pipeline/spec.md`. Confirmed:

- `SetlistSongResponse` gained exactly the three spec'd fields (`defaultKey`,
  `effectiveKey`, `isOverridden`), and `toSetlistSongResponse` derives them as spec'd:
  `effectiveKey = row.key_override ?? defaultKey`, `isOverridden = row.key_override != null`
  (a strict non-null check, not an equality comparison against `defaultKey` — matches the
  spec's edge case #3 requirement exactly).
- The new `loadSongResponses` helper correctly skips the `songs` query when `songIds` is
  empty (`if (songIds.length > 0)`), builds a `Map<songId, defaultKey>` via a single
  `.in("id", songIds)` call, and defaults to `null` via `defaultKeyById.get(r.song_id) ??
  null` when a song row is somehow missing from the map.
- All three handlers (`reorderSetlist`, `addSetlistSong`, `removeSetlistSong`) now route
  through `loadSongResponses` instead of the old `loadOrderedSongs(...).map(...)` tail,
  preserving their existing status codes (201 add, default 200 elsewhere) and existing
  500 `INTERNAL` mapping on query error.
- BR-09 validation (`isValidSongKey` checks, 422 for a shape-valid-but-non-musical key,
  400 for a malformed/shape-invalid body) is untouched in both `reorderSetlist` and
  `addSetlistSong` — confirmed no code was moved or altered there, per the spec's explicit
  "out of scope" instruction.
- No insert/update payload logic copies `default_key` into `key_override` anywhere in the
  file (`key_override: entry.keyOverride ?? null` / `parsed.keyOverride ?? null` in both
  write paths) — `default_key` is never written by any of these three handlers, satisfying
  AC #3.
- No schema, migration, or Zod (`schemas/setlists.ts`, `schemas/songs.ts`) changes were
  made, matching the spec's explicit out-of-scope list.

## New independent test coverage added

New file: `tests/unit/app/api/setlists-key-override.test.ts` (16 tests), written with a
separate fake-Supabase-client implementation and separate fixture IDs from the Coder's
maintained suite, so a bug that happens to cancel out against the Coder's own test file
wouldn't also cancel out here.

**Pure unit coverage of `toSetlistSongResponse` (AC #4 derivation logic in isolation):**
- override `null` -> `isOverridden: false`, `effectiveKey` falls back to `defaultKey`.
- override set to a value different from `defaultKey` -> `isOverridden: true`,
  `effectiveKey` = the override.
- **spec edge case #3**: override value equals `defaultKey` exactly -> still
  `isOverridden: true` (confirms the field is derived from `key_override != null`, not
  from an equality comparison).
- **spec edge case #4**: `defaultKey` null and no override -> `defaultKey`,
  `effectiveKey` both `null`, `isOverridden: false`.
- `defaultKey` null but override set -> `effectiveKey` = the override, `isOverridden: true`.

**AC #4 through the actual route handlers (integration-style, exercises the full
`loadSongResponses` join):**
- PUT reorder: override equal to default still reports `isOverridden: true` end-to-end.
- PUT reorder: song with `default_key: null` and no override reports both derived key
  fields as `null` and `isOverridden: false`.
- **AC #3**: after setting overrides via PUT, the underlying `songs.default_key` catalog
  rows are asserted unchanged, and the response's `defaultKey` field still reflects the
  catalog value, not the override — confirms overrides never leak into the catalog.
- POST add: happy path reports correct `defaultKey`/`effectiveKey`/`isOverridden` for the
  newly inserted row.
- DELETE remove: removing the last remaining song returns `{ songs: [] }` **and** asserts
  (via a `from()` call-count spy) that the `songs` table is never queried in that case —
  confirms the `songIds.length > 0` guard actually skips the query, not just that the
  response happens to be empty.

**BR-09 / AC #2 independent verification (both endpoints, per changes.md's explicit
request that the Tester cover this independently):**
- PUT: malformed JSON body -> 400 `VALIDATION_FAILED`, no DB call attempted.
- PUT: shape-valid but non-musical `keyOverride` ("H") -> 422, and the underlying fake
  state is asserted to still have `key_override: null` (no partial mutation before the
  validation short-circuit).
- POST: malformed body (missing `songId`) -> 400.
- POST: shape-valid but non-musical `keyOverride` ("Zz") -> 422, and the fake
  `setlistSongs` array length is asserted unchanged (nothing inserted).
- PUT: a valid Unicode-accidental key spelling ("F♯") is accepted (200), confirming
  BR-09's dual ASCII/Unicode key set from `schemas/songs.ts` is honored end-to-end.

**Failure case:**
- PUT reorder: forces the second-stage `songs` join query (inside `loadSongResponses`,
  after the `setlist_songs` update has already succeeded) to return a Supabase error, and
  asserts the handler surfaces this as 500 `INTERNAL` rather than a silent/partial 200
  response.

## Notes for Reviewer

- No code changes were made by this stage; only tests were added
  (`tests/unit/app/api/setlists-key-override.test.ts`). All findings are PASS.
- The `console.warn` lines seen in the full-suite output (Google Calendar token revoke,
  Node 20 deprecation notice) are pre-existing, expected output from other suites'
  mocked error paths, unrelated to this issue and not new failures.
- Nothing was patched around — the implementation matched the spec on every point
  checked, including the trickiest edge case (override value equal to default still
  reporting `isOverridden: true`). Ready for Review.
