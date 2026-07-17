# Test Results — Issue #64: Setlist Builder screen

This overwrites the stale `test-results.md` for issue #63 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: 1 FAILING TEST — pipeline paused for Review (not fixed here, per contract)

## What I did

Independently re-ran the coder's claimed verification and added new,
independent test coverage (`changes.md` states no tests were added in the
Coding stage for this issue):

- `bun run lint` — clean (after fixing lint issues in my own new test file:
  no `any`, no unused vars).
- `bun run typecheck` — clean.
- `bun run test` (full suite) — **78 suites / 1001 tests: 1000 passed, 1
  failed.** The single failure is a genuine spec-vs-implementation
  discrepancy found by my new frontend test (see below), not a flake and not
  a bug in the test itself. All 3 pre-existing setlist suites named in the
  spec (`setlists-songs-route.test.ts`, `setlists-key-override.test.ts`,
  `setlists-publish-route.test.ts`) still pass unmodified.

## New test files added

### `tests/unit/app/api/setlists-get-route.test.ts` (backend, 19 tests, all passing)

Covers the new `GET /api/setlists/:id` (`getSetlistWithSongs`) and the
`notes`-persistence guard added to `reorderSetlist`, using the same stateful
in-memory fake-Supabase pattern as the existing
`setlists-songs-route.test.ts`:

- Happy path: returns the setlist + ordered songs (joined to `defaultKey`)
  for a **draft** setlist.
- Also returns songs for a **published** setlist (client needs status to
  render the locked state) — spec's explicit acceptance criterion.
- Allows both `admin` and `set_leader` roles.
- Tenant scoping: a setlist belonging to another `church_group_id`, and a
  wholly nonexistent id, both return **404 NOT_FOUND** (never 403 — does not
  leak existence), matching the spec's explicit requirement.
- `member`/`guest` roles → 403 FORBIDDEN (Supabase never called).
- No JWT → 401 UNAUTHENTICATED (Supabase never called).
- DB error on the setlist lookup → 500 INTERNAL.
- DB error on the songs/defaultKey join → 500 INTERNAL.
- `notes` guard on `PUT /api/setlists/:id`: omitting `notes` on an entry
  leaves the existing note untouched; `notes: null` clears it; a string sets
  it; an overlong (>1000 char) note is rejected as 400 VALIDATION_FAILED
  (Zod `.max(1000)`).

### `tests/unit/app/setlist-builder.test.tsx` (frontend, 18 of 19 tests passing)

Covers `app/(app)/setlists/[id]/setlist-builder.tsx`, mirroring
`week-view.test.tsx`'s URL-keyed `fetch` mock pattern:

- Loading state, happy path (renders catalog search results + setlist rows +
  song count), zero-songs empty state with Publish still enabled and the
  "no songs yet" confirmation copy.
- Search: case-insensitive substring filter scoped to the catalog panel only
  (a song already in the setlist still shows in the right-hand setlist panel
  even when filtered out of the left-hand search results — that is correct,
  expected behavior, not a bug).
- Search-no-match quick-add form: **FAILS** — see "Bug found" below.
- Duplicate-add 409 → inline "already in the setlist" message, no state
  mutation.
- Quick-add flow: create a catalog song then auto-add it to the setlist
  (deliberately isolated from the prefill bug below by typing the title
  directly, so this test exercises the create-then-add mechanics on their
  own).
- Key override: choosing a non-default key sends that `keyOverride`;
  re-choosing the song's own default key sends `keyOverride: null`.
- A song whose `defaultKey` is `null`: blank select option round-trips to a
  `null` override.
- Notes: typing alone does **not** PUT (only on blur); blur sends the
  trimmed value.
- PUT failure: shows an inline alert and resyncs via a follow-up `GET
  /api/setlists/:id`.
- Remove: DELETE removes the row from the setlist panel and updates the
  count (song remains visible in the catalog/search panel, as expected).
- Publish: happy path (confirmation modal → POST → locked/published state
  with Unlock banner) and 409 → "Setlist is already published."
- Published/locked state on initial load: all editing controls (Add,
  key select, notes input, Remove, Publish) disabled; Unlock re-enables them.
- 403/404 on initial load → forbidden/not-found views.
- Catalog load failure (non-403) degrades to an empty catalog (search still
  renders; setlist rows fall back to "Unknown song") rather than failing the
  whole screen.
- Network error on load → generic error view.

## Bug found (the 1 failing test) — NOT fixed here, per pipeline contract

**Test:** `SetlistBuilder › search no match: shows the quick-add form
prefilled with the search term`
(`tests/unit/app/setlist-builder.test.tsx`)

**Spec requirement** (`.pipeline/spec.md`, "Left panel — search + quick-add"):
> Quick-add form shown when the search term is non-empty and no catalog row
> matches: **title (prefilled with the search term, required)**, artist
> (optional), key `<select>`...

**Actual behavior:** `app/(app)/setlists/[id]/setlist-builder.tsx` maintains
`quickAddTitle` as an independent `useState("")` that is never initialized or
synced from `searchTerm`:

```tsx
const [searchTerm, setSearchTerm] = useState("");
...
const [quickAddTitle, setQuickAddTitle] = useState("");
```

There is no effect or derived value that seeds `quickAddTitle` from
`searchTerm` when the quick-add form appears. Typing a search term that
matches no catalog song correctly reveals the quick-add form (`showQuickAdd`
logic itself is correct), but the Title field renders empty instead of
prefilled with what the user just typed — the user has to retype the title
they already entered in the search box. This is a real, reproducible
spec/behavior gap, confirmed by reading the component source, not a
test-authoring mistake.

This also would have caused a second, cascading test failure ("quick-add
flow" happy path — empty title triggers the client-side "Title is required."
validation, blocking the submit so no POST ever fires) had I not
deliberately typed the title directly in that test to isolate the
create-then-add flow from this prefill bug. I kept the two as separate tests
so the review stage can see the prefill gap in isolation rather than have it
masked by a second, unrelated-looking failure.

## Recommendation

Per AGENTS.md's testing-stage contract ("A failing test pauses the pipeline
for review; it is not something this stage patches around"), I have not
modified `setlist-builder.tsx`. A minimal fix would be seeding
`quickAddTitle` from `searchTerm` at the point the quick-add form becomes
visible (e.g. an effect keyed on `showQuickAdd`/`searchTerm`, or deriving the
input's displayed value directly), then re-running this test.

## Everything else checked and not touched

Per spec's "Explicitly out of scope": Spotify enrichment, the `TODO(#64)`
"Edit setlist" button wiring in `week-view.tsx`, and the shapes of
`toSetlistSongResponse` / `SetlistSongResponse` / `addSetlistSongSchema` were
left untouched by the Coding stage and I did not test them further (already
covered by pre-existing suites, all still green).

## Files added by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-64/tests/unit/app/api/setlists-get-route.test.ts`
- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-64/tests/unit/app/setlist-builder.test.tsx`

No implementation files were modified. Ready for Review, with the one bug
flagged above.
