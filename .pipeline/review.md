# Review — Issue #64: Setlist Builder screen

## VERDICT: SHIP

The prior blocker is genuinely fixed. The `wasQuickAddShownRef` latch is gone;
`quickAddTitle` is now re-synced to `searchTerm` on **every** `searchTerm`
change while the quick-add form is shown and the user has not edited the Title
field themselves. I traced the state machine by hand (not from the reports) and
could not construct an input sequence that reproduces the stale-prefix /
junk-catalog-row behavior that caused the previous BLOCK. The new test is a
real regression guard, and lint/typecheck/full suite are green when I run them
myself.

Two non-blocking notes are recorded below; neither justifies another round.

## Why I believe the fix is correct (my own reasoning)

`app/(app)/setlists/[id]/setlist-builder.tsx`:

- **State (line 50):** `const [quickAddTitleDirty, setQuickAddTitleDirty] = useState(false);`
- **Seeding effect (lines 122–136):** deps `[searchTerm, catalog, quickAddTitleDirty]`.
  When `showQuickAdd` is true and `!quickAddTitleDirty` → `setQuickAddTitle(searchTerm)`.
  When `showQuickAdd` is false → `setQuickAddTitleDirty(false)`.
- **Title `onChange` (lines 463–466):** sets the value *and* `setQuickAddTitleDirty(true)`.
  This is the only place the flag is set to `true`, so "dirty" strictly means
  "the human typed in the Title box".

Case analysis:

1. **Incremental typing, no manual title edit.** Every keystroke changes
   `searchTerm` → the effect re-runs → form still shown, flag still `false` →
   title re-seeded to the *current* full search term. No latch, no freeze. This
   is precisely the previously-broken path.
2. **User edits the Title, then keeps typing in search.** The `onChange` sets
   the flag before the next effect run, so the effect's `!quickAddTitleDirty`
   guard short-circuits and the manual value survives. Verified by test.
3. **Form goes hidden (search cleared, or search starts matching a catalog
   row).** The `else` branch resets the flag, so the next time the form appears
   it seeds fresh from the new search term. Correct: the form's identity is
   "the thing shown for the current no-match search", so a manual edit should
   not survive the form disappearing.
4. **`handleQuickAdd` success interaction.** `handleQuickAdd` (lines 212–244)
   appends the created song to `catalog`, `await handleAdd(song.id)`, then
   resets `quickAddTitle`/artist/key to `""`. `handleAdd` on success calls
   `setSearchTerm("")` (line 206) → the effect sees `showQuickAdd === false` →
   flag resets to `false` and the form hides. So the reset of `quickAddTitle`
   to `""` cannot be immediately clobbered by a re-seed, and the flag does not
   leak into the next quick-add. (The previous review asked for an explicit
   flag reset in `handleQuickAdd`; the `setSearchTerm("")` path makes it
   redundant on the success path. See note 1 for the one path it does not
   cover.)
5. **Rapid/duplicate catalog updates.** `catalog` is a dep, so a new array
   identity re-runs the effect; the effect is idempotent (`setQuickAddTitle`
   to the same string and `setQuickAddTitleDirty(false)` when already `false`
   both bail out via `Object.is`, so no render loop). If a catalog refresh
   makes the term match, the form hides and the flag resets — correct.
6. **No infinite loop / no cross-field interference.** The only state the
   effect writes is `quickAddTitle` and `quickAddTitleDirty`, both convergent.
   `quickAddArtist` / `quickAddKey` are untouched by the effect.
7. **Data-corruption vector closed.** The Title submitted by `handleQuickAdd`
   is now always exactly what the user sees in the field (either the live
   search term or their own edit), so `POST /api/songs` can no longer write a
   truncated-prefix junk row into the shared church-group catalog.

## Test quality

`tests/unit/app/setlist-builder.test.tsx`:

- The new **"prefilled title tracks the search term through incremental
  (letter-by-letter) typing"** test fires 18 sequential `fireEvent.change`
  calls on the search box with progressively longer prefixes of
  `"Xylophone Jam 2000"` and asserts `getByLabelText(/title/i)` equals the
  prefix **after every step**, not only at the end. That is exactly the shape
  the old ref-based code failed on (it would freeze at `"X"` and fail on
  iteration 2), so it is a genuine guard, not a tautology. It is also not
  trivially passing: `getByLabelText(/title/i)` throws if the quick-add form
  is not rendered, so the test would fail loudly if the form stopped showing.
- The fixture-choice comment is correct and load-bearing: none of the fixture
  titles/artists (`Amazing Grace`/`Traditional`, `How Great Thou Art`,
  `10,000 Reasons`/`Matt Redman`) contains an `x`, so every prefix is a real
  no-match. A `"T…"` target would have matched on the first character and
  masked the bug — the earlier round's blind spot.
- The companion **"further edits … are not clobbered"** test drives the other
  branch (manual edit, then continued search typing) and asserts both that the
  form is still shown and the edited title survived. Together the two tests
  pin both sides of the `quickAddTitleDirty` guard.
- I did not re-run the Testing stage's mutation check (it would require editing
  source, and this stage is read-only), but the claimed failure mode is exactly
  what the ref-latch logic implies, and the test's per-step assertion makes the
  check structurally sound.

## What I verified myself this run

- `bun run lint` — 0 errors, 1 pre-existing warning in the generated artifact
  `coverage/lcov-report/block-navigation.js` (unrelated to this change).
- `bun run typecheck` — clean.
- `bun run test` — **79 suites / 1003 tests, all passing.** Matches
  `test-results.md`.
- `git status --short` / `git diff --stat` — scope is exactly as expected:
  4 staged deletions of byte-identical `" 2"`-suffixed duplicate test files
  (I confirmed `tests/unit/app/week-view.test 2.tsx` is byte-identical to the
  real file), `app/(app)/setlists/[id]/setlist-builder.tsx` (+20/-9, only the
  dirty-flag change and the now-unused `useRef` import removal), the two added
  tests in `tests/unit/app/setlist-builder.test.tsx`, and the three
  `.pipeline/` docs. No stray files, no unrelated source edits.

## Non-blocking notes (do not require another pipeline round)

1. **Create-succeeds-but-add-fails leaves the flag stuck.** In
   `handleQuickAdd`, if `POST /api/songs` succeeds but the follow-up
   `handleAdd` fails (non-ok/throw), `setSearchTerm("")` never runs, so the
   form stays visible with `quickAddTitle === ""` and
   `quickAddTitleDirty === true` (if the user had edited the title) — meaning
   it will not re-seed until the form hides. The `required` attribute prevents
   submitting an empty title, so this is a cosmetic dead-end, not a data
   problem. A one-line `setQuickAddTitleDirty(false)` next to the existing
   resets in `handleQuickAdd` would close it.
2. **Duplicated `showQuickAdd` predicate** (still open from the previous
   review): computed once in the effect (line 124, `catalog.some(...)`) and
   once in the render body (line 386, `filteredCatalog.length === 0`). They are
   equivalent today and must not drift. Worth unifying opportunistically.

## Process note (for the human)

The 4 duplicate-file deletions, the source fix, the new tests, and the
`.pipeline/` updates are all staged/working-tree only. They must be committed
before the PR is finalized, or `git diff main...HEAD` will still show the 4
junk duplicate test files as *added*.

## Previously verified, re-confirmed as unchanged by this round

Backend `GET /api/setlists/:id` (auth + role gate, tenant-scoped, 404 not 403
for missing/other-tenant, `{ setlist, songs }` for draft and published), the
`entry.notes !== undefined` guard in `reorderSetlist`, the `nullish()` notes
field on `reorderSetlistSchema` only, `SONG_KEY_OPTIONS`, and the rest of the
frontend (load/degrade behavior, duplicate-add 409, key-equals-default → null,
notes persist-on-blur, full-set PUT with resync-on-failure, native HTML5 drag
with no new dependency, zero-song Publish copy, locked state + Unlock). This
round's diff touches none of it.
