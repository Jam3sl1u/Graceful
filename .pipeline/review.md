# Review — Issue #53: Song catalog CRUD + search (BR-09 key validation)

VERDICT: NEEDS WORK

## What I verified independently
- Re-ran from the pinned worktree: `bun run lint` clean, `bun run typecheck`
  clean, `bun run test -- songs` → 38 tests pass across the Coder's suite
  (`songs-route.test.ts`, 28) and the Tester supplement
  (`songs-route-tester-supplement.test.ts`, 10, currently untracked).
- Read the full `git diff main...HEAD`. Scope is exactly the five spec-named
  files (`schemas/songs.ts`, `app/api/songs/handler.ts`,
  `app/api/songs/route.ts`, `lib/supabase/types.ts`, the Coder test) plus
  `.pipeline/`. No migrations touched. No unrelated refactors. The handler
  faithfully mirrors `app/api/instruments/handler.ts` (auth → role → JWT guard
  → query → try/catch tail → narrow Insert cast).
- BR-09 422-vs-400 split is correct: Zod shape failure → 400; syntactically
  valid but invalid key value → 422, checked in the handler after Zod's trim.
  `VALID_SONG_KEYS` holds the 17 ASCII + 10 Unicode spellings, case-sensitive.
- Role gating (list: admin/set_leader/member; create: admin/set_leader) runs
  before any DB call; 401-no-JWT before `getSupabaseClient`. Confirmed by tests.

## Must fix (blocking this verdict)

1. **Explicit `null` on optional fields returns 400, but the spec says
   `default_key` null → 201.** `schemas/songs.ts` uses `.optional()` on
   `default_key`, `artist`, `bpm`, and `tags`. Zod's `.optional()` accepts
   `undefined` (omitted) but rejects an explicit JSON `null` — I verified this
   directly: `createSongSchema.safeParse({ title: "x", default_key: null })`
   → `success: false` (same for artist/bpm/tags). So a client POSTing
   `{"title":"x","default_key":null}` gets **400**, whereas
   `.pipeline/spec.md` line 234 lists under "Edge cases the implementation MUST
   handle": "`default_key` omitted / null → 201 (allowed)". Neither test suite
   exercises the explicit-null path, so the green suite masked this gap.
   - Note the spec is internally inconsistent: its prescribed schema (line 53,
     `.optional()`) contradicts its own edge-case bullet (line 234). The Coder
     followed the schema line verbatim, which is why this slipped through.
   - Fix (pick one, then align the spec so they agree):
     (a) Make the fields accept null-as-omitted, e.g.
     `default_key: z.string().trim().min(1).max(5).nullish()` (or
     `.nullable().optional()`), which lets `default_key ?? null` in the handler
     do the right thing and yields 201. Apply consistently to
     `artist`/`bpm`/`tags` if the same null-tolerance is wanted; OR
     (b) correct spec line 234 to say null → 400 and keep the code as-is.
   - Add a test for `default_key: null` → 201 (and, if fixing artist/bpm/tags,
     their null cases) so the resolved behavior is pinned.

## Non-blocking observations (do not need a re-run to ship, but worth noting)
- **PostgREST `.or()` interpolation.** `listSongs` builds
  `` `title.ilike.%${q}%,artist.ilike.%${q}%` `` by interpolating raw user
  input. This is the exact pattern the spec prescribed, and impact is contained:
  RLS plus `.eq("church_group_id", ctx.churchGroupId)` scope every row to the
  caller's own tenant, and an unfiltered list already returns all of them — so
  a crafted `q` cannot expose data the caller can't already read. Worst
  realistic case is a malformed filter → PostgREST error → 500. Acceptable for
  this issue; a future hardening pass could escape `%`/`,`/`)` in `q`.
- The Tester supplement file and updated `test-results.md` are uncommitted
  working-tree changes — expected mid-pipeline; the Coder's committed suite
  stands on its own.

## Bottom line
Clean, well-scoped, faithfully patterned, and the BR-09 acceptance criterion
(the crux of the issue) is implemented and tested correctly. The one concrete
defect is the explicit-`null` optional-field behavior diverging from a
spec-mandated edge case, uncaught by either suite — a small, well-scoped fix
plus a spec reconciliation. Fix that (and its test) and this is a SHIP.
