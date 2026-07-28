# Test Results — Issue #64: Setlist Builder screen

This overwrites the previous `test-results.md` (which incorrectly signed off
on the ref-based `wasQuickAddShownRef` fix — that fix was subsequently found
broken on critical re-review and BLOCKed; see `.pipeline/changes.md`
"Follow-up fix (post-review)" for the full history). Per AGENTS.md,
`.pipeline/` files reflect only the most recent run.

## Verdict: ALL TESTS PASSING — corrected (`quickAddTitleDirty`-based) fix verified against the exact regression the reviewer found

## What I did

Independently re-verified the **corrected** fix (a `quickAddTitleDirty`
boolean state, not the earlier `wasQuickAddShownRef` ref) rather than
trusting `changes.md`'s claims:

1. Read the current `app/(app)/setlists/[id]/setlist-builder.tsx` directly
   (seeding `useEffect`, Title `onChange`, `handleQuickAdd`):
   - `quickAddTitleDirty` is set `true` only inside the Title input's own
     `onChange` handler.
   - The seeding `useEffect` (deps `[searchTerm, catalog, quickAddTitleDirty]`)
     re-runs on **every** `searchTerm` change while the quick-add form is
     shown, and calls `setQuickAddTitle(searchTerm)` whenever
     `!quickAddTitleDirty` — i.e. it is not gated by a latch that only fires
     once. It resets `quickAddTitleDirty` to `false` when the form goes
     hidden. This is architecturally different from the earlier broken
     ref-based latch and does genuinely handle progressive/incremental
     typing, not just single-shot paste.

2. Checked the existing test file
   (`tests/unit/app/setlist-builder.test.tsx`) and confirmed neither existing
   test reproduced the real regression shape: both used single
   `fireEvent.change` calls with the full final string (paste semantics), or
   two discrete jumps with a manual title edit between them — never a
   sequence of `fireEvent.change` calls simulating letter-by-letter typing
   with no title interaction, which is exactly the shape that would have
   caught the original broken ref-based fix.

3. Added a new test: **"search no match: prefilled title tracks the search
   term through incremental (letter-by-letter) typing, not just a single
   paste"**. It fires 19 sequential `fireEvent.change` calls on the search
   input with progressively longer prefixes of `"Xylophone Jam 2000"` (one
   character added each time, none matching the fixture catalog), asserting
   the Title field's value equals the search term after **every single
   step**, not just the end state. (Target string chosen so no catalog
   title/artist contains "x" — a `"T..."` target's very first character
   would substring-match "How Great Thou Art" and mask the bug by never
   entering quick-add mode long enough to matter.)

4. **Verified the test is a real regression guard, not a tautology**: I
   temporarily reintroduced the old broken `wasQuickAddShownRef`-based
   seeding logic in place of the current `quickAddTitleDirty` logic and
   reran the test in isolation. It failed exactly as expected — the title
   froze at `"X"` after the first keystroke (`Expected: "Xy"`, `Received:
   "X"`) — confirming this test would have caught the original blocking
   bug. I then restored the file to the corrected implementation from a
   backup and diffed to confirm an exact, clean restore (no ref-based code
   left behind).

5. Ran `bun run lint`, `bun run typecheck`, and `bun run test` (full suite)
   for real, from the repo root, against the restored corrected code.

6. Confirmed via `git status --short` that the working tree only shows the 4
   expected staged deletions (duplicate " 2"-suffixed test files), the
   `.pipeline/changes.md` edit, the `app/(app)/setlists/[id]/setlist-builder.tsx`
   edit, `tests/unit/app/setlist-builder.test.tsx` (my new test), and
   `.pipeline/review.md` (pre-existing modification from the prior BLOCK
   verdict, not touched by me this run) — nothing unexpected.

## Results

- `bun run lint` — clean. (One pre-existing, unrelated warning in a
  generated coverage-report artifact, `coverage/lcov-report/block-navigation.js`;
  not part of this change.)
- `bun run typecheck` — clean, no errors.
- `bun run test` (full suite) — **79 suites / 1003 tests, all passing.**
- `tests/unit/app/setlist-builder.test.tsx` in isolation: **21/21 passing**,
  including the new incremental-typing test and the pre-existing
  "further edits ... not clobbered" test (which covers a different angle:
  preserving a manual edit across continued search typing, not the
  incremental-typing-without-manual-edit regression itself).

## Is the incremental-typing scenario genuinely covered?

Yes. Prior to this run, no test in the suite simulated sequential keystrokes
without a manual title edit in between — the exact scenario the second
review round identified as uncaught. The new test does, it passes against
the current (`quickAddTitleDirty`) implementation, and it was confirmed to
fail against the previously-BLOCKed ref-based implementation, so it is a
genuine regression guard rather than incidental coverage.

## Files touched by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/tests/unit/app/setlist-builder.test.tsx`
  — added one new test (incremental/letter-by-letter typing). No other test
  files modified this run.

No implementation files were modified by this stage (the temporary
regression-revert during verification step 4 was restored from a backup
before running the final full suite; the working tree reflects only the
Coding stage's corrected fix). Ready for Review.
