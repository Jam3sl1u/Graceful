# Review — Issue #64: Setlist Builder screen

## VERDICT: SHIP

This round is a targeted final pass over the two non-blocking items the prior
SHIP recorded (stuck `quickAddTitleDirty` flag; duplicated catalog-match
predicate). Both are correctly fixed, the new regression test is a real guard
(I mutation-tested it myself), and lint/typecheck/full suite are green when I
run them. The previously-reviewed-and-SHIPped core of #64 is untouched by this
diff. No new issues found; nothing left open.

## Scope of this diff (verified)

`git status --short` / `git diff --stat`:

```
 .pipeline/changes.md                        | 23 +++++++++++++++++
 app/(app)/setlists/[id]/setlist-builder.tsx | 18 ++++++++------
 tests/unit/app/setlist-builder.test.tsx     | 38 +++++++++++++++++++++++++++++
```

Three files, +72/-7, working tree only (nothing staged, `git diff HEAD --stat`
identical). The 4 duplicate `" 2"`-suffixed test files flagged in the previous
round are gone from the working tree. No stray files, no unrelated source
edits, no backend/CSS changes.

## Fix 1 — stuck dirty flag (`handleQuickAdd`)

`app/(app)/setlists/[id]/setlist-builder.tsx:246` adds
`setQuickAddTitleDirty(false);` alongside the existing
`setQuickAddTitle("") / setQuickAddArtist("") / setQuickAddKey("")` resets.

My own trace of the paths:

1. **Create OK + add OK (happy path).** `handleAdd` calls `setSearchTerm("")`
   (line 211) → the seeding effect sees `showQuickAdd === false` and already
   reset the flag via its `else` branch. The new line is redundant here and
   changes nothing — confirmed by the pre-existing quick-add happy-path test
   still passing.
2. **Create OK + add FAILS (the reported bug).** `setSearchTerm("")` never
   runs, so `searchTerm` still holds a term that (if the created title diverged
   from it) matches nothing — including the newly appended catalog entry — so
   `showQuickAdd` stays `true` and the effect's `else` branch never fires.
   Pre-fix: `quickAddTitle === ""` with `quickAddTitleDirty === true` → the
   `!quickAddTitleDirty` guard blocks re-seeding and the field is stuck blank.
   Post-fix: the flag is cleared, the effect (deps include
   `quickAddTitleDirty`) re-runs and re-seeds `quickAddTitle` from the current
   `searchTerm`. Correct.
3. **Create FAILS (`!res.ok` or throw).** The function returns early / lands in
   `catch` *before* the resets, so the flag stays `true` and the user's typed
   title survives for a retry. This is the right behavior and the fix
   deliberately does not touch it — worth calling out because clearing the flag
   there would have destroyed user input.
4. **No new render-loop risk.** `setQuickAddTitleDirty(false)` when already
   `false` bails out via `Object.is`; the effect remains convergent
   (`quickAddTitle` settles at `searchTerm`, flag settles at `false`).

## Fix 2 — `filterCatalog` extraction

New module-level helper at
`app/(app)/setlists/[id]/setlist-builder.tsx:39-44`, used by the seeding effect
(line 132) and the render-time `filteredCatalog` (line 389).

- The predicate is character-for-character the same rule both call sites used
  before (`title` OR `artist ?? ""`, `.toLowerCase().includes(term)`), so this
  is a pure extraction with no behavior change.
- The effect's `catalog.some(pred)` → `filterCatalog(...).length === 0` swap is
  logically equivalent (`!some(p)` ≡ `filter(p).length === 0`). It trades
  short-circuiting for an allocation; catalogs here are a single church group's
  song list rendered in full on every keystroke anyway, so this is noise, not a
  performance regression.
- Both call sites pass an already `trim().toLowerCase()`-normalized `term`
  (lines 131 and 388), so the helper's implicit "term must be pre-normalized"
  contract holds today. Stylistic nit only, not a defect: normalizing inside
  the helper would make it misuse-proof. Not worth a round.
- Pure function, module-level, no closure over component state — no hook-order
  or stale-capture concerns.

## Test quality — I proved the new test is not tautological

`tests/unit/app/setlist-builder.test.tsx:277-313`, "quick-add flow: a failed
add-to-setlist after a successful song creation still leaves the title
resyncable (not stuck blank)".

The test mocks `POST /api/songs` → 201 and `POST /api/setlists/:id/songs` →
409, types a search term (`"Divergent Search Term"`) that no fixture matches,
deliberately diverges the Title to `"My Custom Title"` (setting the dirty flag
via the field's own `onChange`), submits, waits for the inline 409 message,
then asserts the Title field has re-populated to the current search term.
The divergence matters: it guarantees the newly-appended catalog entry still
does not match the search term, so the quick-add form stays mounted and the
"stuck blank" state is actually reachable.

Rather than trust that reasoning, I copied the tree to a scratch directory,
deleted **only** the `setQuickAddTitleDirty(false);` line from `handleQuickAdd`,
and reran the suite file there:

```
Tests: 1 failed, 21 passed, 22 total
● quick-add flow: a failed add-to-setlist ... (not stuck blank)
  Expected the element to have value: Divergent Search Term
  Received: (empty)
```

Exactly the reported bug, and exactly one test fails — so the assertion is
genuinely load-bearing and no other test was silently depending on the old
behavior. The `filterCatalog` extraction is covered transitively by the
existing search/quick-add-visibility tests (any drift in the predicate would
change which rows render).

## Verified myself this run

- `bun run lint` — 0 errors. 1 warning, in the gitignored generated artifact
  `coverage/lcov-report/block-navigation.js` (confirmed `.gitignore:13`);
  unrelated to this diff and unchanged from prior rounds.
- `bun run typecheck` — clean.
- `bun run test` (full suite) — **79 suites / 1004 tests, all passing**
  (1003 + the one new test).
- `git status --short`, `git diff`, `git diff HEAD --stat` — scope as above.

## Notes for the human (non-blocking, no action required before merge)

1. `.pipeline/test-results.md` was not refreshed for this cleanup round — it
   still describes the previous round (1003 tests) and does not mention the new
   "not stuck blank" test. Documentation drift only; I ran the suite and the
   mutation check myself this round, so verification coverage is not actually
   missing.
2. Pre-existing UX nit, unchanged by this diff and out of scope: on the
   create-OK/add-409 path the right-hand setlist panel is not refreshed
   (`handleAdd` returns early before `setSongs`), so a song that the server
   says is already in the setlist may not be visible there until the next
   reload. Worth a separate issue if it ever matters.

## Previously verified, re-confirmed as untouched by this round

Backend `GET /api/setlists/:id` (auth + role gate, tenant-scoped, 404 not 403),
the `entry.notes !== undefined` guard in `reorderSetlist`, the `nullish()` notes
field on `reorderSetlistSchema`, `SONG_KEY_OPTIONS`, and the rest of the
frontend (load/degrade behavior, duplicate-add 409, key-equals-default → null,
notes persist-on-blur, full-set PUT with resync-on-failure, native HTML5 drag
with no new dependency, zero-song Publish copy, locked state + Unlock), plus
the previously-SHIPped `quickAddTitleDirty` prefill fix itself. This diff
changes none of it.
