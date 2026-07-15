# Review — Issue #55: Add/remove/reorder setlist songs (BR-07 no duplicates)

## VERDICT: SHIP

## What I verified (not trusted from prior stages)
- Ran `git diff main...HEAD`: only in-scope files touched — `schemas/setlists.ts`,
  `lib/supabase/types.ts`, new `app/api/setlists/[id]/handler.ts`, and the three
  route stubs replaced with thin wrappers. No migrations, no dependency changes,
  no unrelated refactors. Matches the spec's file list exactly.
- Re-ran `bun run lint` (clean), `bun run typecheck` (clean), `bun run test`
  (59 suites / 764 tests pass, incl. the new 35-test suite run in isolation).

## Correctness assessment
- `reorderSetlist` (PUT): body-parse → BR-09 (422) → editable guard → duplicate
  songId (400) → exact songId-set match vs current rows (400) → per-row position
  (1-indexed from array order) + key_override update → reload ordered. Matches
  spec algorithm. Auth/role checked before any DB access.
- `addSetlistSong` (POST): parse → BR-09 (422) → editable guard → song-in-group
  check (404) → BR-07 pre-check (409) → insert at count+1 with 23505 race
  backstop mapped to 409 → reload, 201. Correct.
- `removeSetlistSong` (DELETE): editable guard → scoped delete with `.select("id")`
  to detect missing/foreign row (404) → position recompaction to 1..N → reload, 200.
  Correct; empty setlist returns `{ songs: [] }`.
- Tenant safety: `setlist_songs` has no church_group_id, but every mutation is
  gated behind `loadEditableSetlist` (parent scoped on id + church_group_id) and
  scoped by setlist_id, with RLS as backstop. Sound.
- Helper signatures confirmed against `lib/api/response.ts` (`ok(data, 201)`,
  `fail(msg, code, status)`) and `lib/api/auth.ts` (requireAuth/requireRole throw
  ApiException, caught by the shared try/catch). No mismatch.

## Test quality
Not superficial. The suite uses a stateful in-memory fake for setlists/songs/
setlist_songs, so assertions check real resulting state: exact recompacted
position/order arrays after a mid-list delete, unchanged row count on a rejected
BR-07 add, key_override cleared via both omission and explicit null. Covers happy
paths, the spec's named edge cases (set mismatch both directions, duplicate
songIds, cross-tenant song/setlist, published-guard on all three verbs), and
failure cases (401/403/404/409/422 plus 500 mapping on update/insert/delete
errors, incl. the 23505 race path).

## Minor, non-blocking observations (no fix required)
- `addSetlistSong` issues two `setlist_songs` selects (count + dup check) where
  one could serve both; the spec explicitly permitted this. Cosmetic.
- Position updates in PUT/DELETE are sequential and non-transactional, so a
  mid-loop DB error can leave positions partially rewritten (returns 500). This
  matches the codebase's existing non-transactional pattern and the spec does not
  require atomicity. Acceptable for this issue.

Green tests here reflect genuinely correct behavior. Ship it.
