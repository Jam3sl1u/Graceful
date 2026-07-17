# Review — Issue #64: Setlist Builder screen

## VERDICT: NEEDS WORK

One concrete, spec-mandated behavior is broken and is backed by a genuine
failing test. Everything else (backend endpoint, notes guard, schema/export
changes, and the rest of the UI) is correct and matches the spec. The fix is
small and localized.

## What to fix

### 1. Quick-add Title must be prefilled with the search term (REQUIRED)

- **File:** `app/(app)/setlists/[id]/setlist-builder.tsx`
- **Spec:** "Left panel — search + quick-add" — *"title (prefilled with the
  search term, required)"*. Also an edge case: *"Search no match: show the
  quick-add form (title required; ...)"*.
- **Problem:** `quickAddTitle` is an independent `useState("")` (line 46) that
  is never seeded or synced from `searchTerm`. When a search matches no catalog
  song the quick-add form appears (correct), but the Title field renders empty.
  A user who then clicks "Add song" without retyping hits the client-side
  "Title is required." guard (`handleQuickAdd`, line 199) and no POST fires —
  the create-then-add flow is dead unless the user retypes the exact title they
  already typed in the search box.
- **Failing test (legitimate, re-run and confirmed here):**
  `tests/unit/app/setlist-builder.test.tsx` ›
  "search no match: shows the quick-add form prefilled with the search term"
  asserts `getByLabelText(/title/i)` has value `"Totally New Song"`; actual
  value is empty. Not a flake, not a test-authoring error — the assertion
  matches the spec verbatim.
- **Suggested fix:** derive/seed the Title field from `searchTerm` when the
  quick-add form is shown — e.g. an effect keyed on `showQuickAdd`/`searchTerm`
  that seeds `quickAddTitle`, or render the input's value from `searchTerm`
  when the field hasn't been independently edited. After the fix, re-run the
  full `setlist-builder.test.tsx` suite (the "quick-add flow" test currently
  side-steps this by typing the title directly; both should pass once seeded).

## What is correct (verified against the actual diff, not just the summaries)

- **Backend `GET /api/setlists/:id` (`getSetlistWithSongs`)** matches spec:
  `requireAuth` + `requireRole(["admin","set_leader"])`, JWT check, tenant-scoped
  load (`church_group_id` eq), missing/other-tenant → 404 (never 403, no
  existence leak), DB errors → 500, reuses `loadSongResponses`, returns
  `{ setlist, songs }` for draft AND published. `route.ts` GET export wired
  correctly, PUT unchanged.
- **Notes persistence guard** in `reorderSetlist` is exactly as speced:
  `notes` only added to the update payload when `entry.notes !== undefined`
  (absent → column untouched; `null` → clear; string → set). Existing
  reorder/key-override callers that omit notes are unaffected.
- **`schemas/setlists.ts`** — `notes: z.string().trim().max(1000).nullish()`
  added to the reorder per-song object only; `addSetlistSongSchema` untouched.
- **`schemas/songs.ts`** — `SONG_KEY_OPTIONS = ASCII_SONG_KEYS` exported;
  `VALID_SONG_KEYS`/`isValidSongKey` untouched. `toSetlistSongResponse` /
  `SetlistSongResponse` shapes untouched (out-of-scope respected).
- **Frontend** otherwise faithful: parallel load with `cancelled` guard,
  403/404/error view routing, non-fatal catalog degradation, client-side
  case-insensitive search scoped to the catalog panel, duplicate-add 409
  inline message, key "equals default → null" logic (incl. `defaultKey: null`),
  notes persist-on-blur only (uncontrolled input keyed by songId), full-set
  PUT via a single `persistSongs` with resync-on-failure, native HTML5 drag,
  zero-songs empty state, Publish never disabled with "no songs yet" modal
  copy, published/locked disabling + Unlock affordance.

## Test quality

The Testing stage's coverage is substantive and independent, not superficial:
19 backend tests (tenant scoping, role/auth gating, draft+published, DB-error
500s, the full notes-guard matrix incl. >1000-char 400) and 19 frontend tests
covering the spec's named edge cases plus failure paths (PUT-failure resync,
network-error view, catalog-degradation). The single red test is a real
spec/behavior gap, correctly left unpatched per the pipeline contract.

## Process note (non-blocking, for the human/orchestration)

The two new test files are currently untracked (`git status`: `??`) and the
implementation commit `118765c` does not include them. They should be committed
alongside the implementation before the PR is finalized so the failing test —
and, once fixed, the passing coverage — travels with the change.
