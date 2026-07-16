# Review — Issue #57: Per-song key override validation & default-vs-override distinction (BR-09)

## VERDICT: SHIP

## What I verified independently
- Ran `git diff main...HEAD` and read the actual handler + test diffs (not just the summaries).
- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run test tests/unit/app/api/setlists-key-override.test.ts tests/unit/app/api/setlists-songs-route.test.ts` — 51/51 passing.
- `bun run test` (full suite) — 67 suites / 846 tests passing. Matches the tester's report exactly; no regressions.

## Assessment against the spec
- **AC #4 (the only new code):** `SetlistSongResponse` gained exactly the three spec'd fields
  (`defaultKey`, `effectiveKey`, `isOverridden`). `toSetlistSongResponse(row, defaultKey)`
  derives them as spec'd: `effectiveKey = key_override ?? defaultKey`,
  `isOverridden = key_override != null` (strict non-null, NOT an equality comparison — spec edge
  case #3 honored). The new `loadSongResponses` helper does a single `.in("id", songIds)` batch
  query (no N+1), skips the query entirely on empty setlists (edge case #1), and defaults missing
  songs to `null` (edge case #5). All three handlers route through it while preserving status
  codes (201 add, 200 elsewhere) and the 500 INTERNAL error mapping.
- **AC #2 (BR-09):** validation at handler lines 143-149 (422 for shape-valid-but-non-musical key,
  400 for malformed body) is untouched, per the spec's out-of-scope instruction. Confirmed by
  reading the code directly.
- **AC #3:** write paths only ever set `key_override`; `songs.default_key` is never written by any
  of the three handlers. No insert/update copies default into override (design decision respected).
- **Out of scope:** no schema/migration/Zod changes, no new GET endpoint, no transposition. Confirmed.

## Test quality
Not superficial. The new independent suite (`setlists-key-override.test.ts`, separate fake client
and fixture IDs from the coder's suite) covers: `toSetlistSongResponse` derivation in isolation,
the tricky override-equals-default case, `default_key: null` cases, AC #3 non-mutation asserted
against catalog state, the empty-setlist path asserted via a `from()` call-count spy (proves the
query is actually skipped, not just that the result is empty), the 400-vs-422 split on both
endpoints, a Unicode-accidental acceptance case, and a genuine failure case (forced error on the
post-update songs join surfaces as 500, not a silent partial 200).

## Notes (non-blocking)
- The `songs` lookup in `loadSongResponses` has no explicit `church_group_id` filter and relies on
  RLS for tenant scoping. This matches the spec's explicit design note and the repo's JWT-scoped
  client pattern; song_ids originate from an already tenant-scoped setlist. Acceptable.
- The tester's new test file and this stage's `test-results.md` are currently untracked/unstaged in
  the worktree — they need to be committed as part of shipping this branch.
