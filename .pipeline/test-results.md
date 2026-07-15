# Test Results — Issue #55: Add/remove/reorder setlist songs (BR-07 no duplicates)

## Verdict: PASS

All checks below were re-run independently by the Testing stage (not
trusted from `.pipeline/changes.md`). Everything is green.

## Commands run

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` — clean, no errors (includes the new test file).
- `bun run test` — **59 suites / 764 tests pass** (58 suites / 729 tests
  pre-existing baseline + 1 new suite / 35 new tests added by this stage).

## New test file

`tests/unit/app/api/setlists-songs-route.test.ts` — 35 tests covering
`reorderSetlist` (PUT), `addSetlistSong` (POST), `removeSetlistSong` (DELETE)
from `app/api/setlists/[id]/handler.ts`.

Rather than reusing the coder's own `songs-route.test.ts`-style mock (whose
`.eq()` is a no-op passthrough that ignores its arguments), this suite uses a
small **stateful in-memory fake** for the `setlists` / `songs` /
`setlist_songs` tables: `.select().eq().eq()`, `.order()`, `.maybeSingle()`,
`.update()`, `.delete().select()`, and `.insert()` all read/mutate real
in-memory row arrays. This lets assertions check actual resulting state
(exact recompacted positions, rejected inserts leaving row count unchanged,
etc.) instead of just the shape of a canned fixture.

### Coverage by endpoint

**PUT /api/setlists/:id (`reorderSetlist`)** — 13 tests:
- Happy path: reorder + position derived 1-indexed from array order;
  verifies `keyOverride` is cleared both by omitting the field and by
  explicit `null`, and set by a new value — confirms the documented
  `entry.keyOverride ?? null` behavior in the spec's algorithm.
- Allows `admin` role.
- 400 on malformed JSON, on a shape-invalid `songId` (non-UUID), on a body
  songId set missing an existing song, on a body songId set with an extra
  song not in the setlist, and on duplicate `songId`s in the body.
- 422 on a shape-valid but BR-09-invalid `keyOverride`.
- 404 for a non-existent / other-tenant setlist.
- 409 CONFLICT for a published setlist.
- 403 for `member`/`guest` (asserts `getSupabaseClient` never called).
- 401 when `getToken` yields no JWT (asserts `getSupabaseClient` never
  called).
- 500 INTERNAL when the update step errors.

**POST /api/setlists/:id/songs (`addSetlistSong`)** — 12 tests:
- Happy path: 201, song lands at `position = count + 1`.
- 404 "Song not found" when `songId` isn't in the caller's group catalog
  (cross-tenant song rejected).
- 409 BR-07 when the song is already in the setlist; asserts nothing was
  inserted (`state.setlistSongs` length unchanged).
- 422 on invalid `keyOverride` (BR-09).
- 400 on a missing/malformed body.
- 404 for a non-existent / other-tenant setlist.
- 409 CONFLICT for a published setlist.
- 403 for `member`/`guest`.
- 401 when `getToken` yields no JWT.
- 500 INTERNAL on a generic insert error.
- 409 CONFLICT (not 500) when the insert error carries Postgres code
  `23505` — the documented race-backstop path.

**DELETE /api/setlists/:id/songs/:songId (`removeSetlistSong`)** — 9 tests:
- Happy path: removing a middle song recompacts remaining rows to exactly
  `1..N` in the correct order (asserted against the full response, not just
  length).
- Removing the last remaining song returns `{ songs: [] }`.
- 404 when the `songId` isn't in the setlist.
- 404 for a non-existent / other-tenant setlist.
- 409 CONFLICT for a published setlist.
- 403 for `member`/`guest`.
- 401 when `getToken` yields no JWT.
- 500 INTERNAL when the delete step errors.

### Failure cases (explicit, per pipeline contract)

Beyond the happy paths, this suite includes numerous failure-path
assertions: 400 (malformed/shape-invalid bodies, songId-set mismatches,
duplicate songIds), 401, 403, 404 (missing setlist, missing song,
cross-tenant), 409 (BR-07 duplicate, published-setlist guard, race
backstop), and 422 (BR-09 key validation), plus 500 mapping for update,
insert, and delete errors.

## Independent verification against the spec

Cross-checked (by direct file inspection, not by trusting `changes.md`)
that the implementation matches `.pipeline/spec.md`:

- `schemas/setlists.ts` — `reorderSetlistSchema` /
  `addSetlistSongSchema` match the spec's shape exactly.
- `lib/supabase/types.ts` — `setlist_songs` Row type and Tables entry
  (Insert/Update/Relationships) added exactly as specified; no migration
  files touched.
- `app/api/setlists/[id]/handler.ts` — `reorderSetlist`, `addSetlistSong`,
  `removeSetlistSong` implement the auth → role → JWT → tenant-scoped
  editable-setlist guard → business-rule checks → mutation → reload-and-
  return flow the spec describes, including the BR-07 pre-check + 23505
  race backstop and the position-recompaction algorithm.
- `app/api/setlists/[id]/route.ts`,
  `app/api/setlists/[id]/songs/route.ts`,
  `app/api/setlists/[id]/songs/[songId]/route.ts` — thin wrappers matching
  the spec's exact code.

## Notes / caveats

- No mutation testing could be performed to positively confirm the new
  tests would fail against a broken implementation: a deliberate attempt to
  temporarily disable the BR-07 duplicate-check branch in
  `app/api/setlists/[id]/handler.ts` to verify the test suite catches it
  was blocked by the sandbox's security classifier (flagged as disabling a
  validation guard in production code), so it was reverted immediately.
  `git status --short` / `git diff --stat` confirm
  `app/api/setlists/[id]/handler.ts` is byte-identical to the tracked
  version — only the new test file is untracked; no implementation files
  were modified by this stage. Confidence instead rests on the tests
  asserting exact resulting state via the stateful fake (e.g., unchanged
  row count on a rejected duplicate add, exact recompacted position/order
  arrays) rather than loose shape checks.

## Files touched by this stage

- `tests/unit/app/api/setlists-songs-route.test.ts` (new)
- `.pipeline/test-results.md` (this file)
