# Test Results — Issue #53: Song catalog CRUD + search (BR-09 key validation)

This overwrites the stale `test-results.md` for issue #52 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verification performed

Ran independently in the pinned worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-53`):

- `bun run lint` — **clean** (0 errors, 0 warnings, after fixing an unused
  import in this stage's own new test file — see below).
- `bun run typecheck` (`tsc --noEmit`) — **clean**.
- `bun run test` (Jest, full suite) — **51 suites / 579 tests passed**
  (50 suites / 569 tests from the Coder's work, plus 1 new suite / 10 tests
  added by this Testing stage).

All of the Coder's `changes.md` claims check out: lint/typecheck/test were
independently re-run from a clean state (not trusted from the report), and
the full suite is green.

## Independent code read

Read `schemas/songs.ts`, `app/api/songs/handler.ts`, `app/api/songs/route.ts`,
and the `songs` table registration in `lib/supabase/types.ts` against
`.pipeline/spec.md`. Confirmed:

- `VALID_SONG_KEYS` contains exactly the 17 ASCII + 10 Unicode spellings
  named in the spec, case-sensitive `Set.has`.
- The BR-09 split is implemented as specified: `createSongSchema.safeParse`
  failure → 400 VALIDATION_FAILED; a syntactically valid but semantically
  invalid `default_key` → 422 VALIDATION_FAILED, checked in the handler
  (not Zod), after `.trim()` (Zod trims before the handler's membership
  check runs).
- `listSongs`: `requireAuth` → `requireRole(["admin","set_leader","member"])`
  → query-schema parse → JWT guard → `.eq("church_group_id", ...)` (defense
  in depth, present) → optional `.or(ilike title/artist)` → `.order("title")`
  → 500 on DB error → `ok({ songs: [...] })`.
- `createSong`: `requireAuth` → `requireRole(["admin","set_leader"])` → body
  parse (400) → BR-09 check (422) → JWT guard (401) → insert with
  `spotify_id` untouched → 500 on error/no data → `ok({ song }, 201)`. No
  duplicate-title 409 guard, matching the spec's explicit instruction.
- `lib/supabase/types.ts` `songs` table entry matches the spec's `SongsRow`
  / `Insert`/`Update`/`Relationships` shape verbatim.
- `app/api/songs/route.ts` wires `GET`/`POST` straight to `listSongs`/
  `createSong`, mirroring `app/api/instruments/route.ts`.

## New tests written by this stage

Added `tests/unit/app/api/songs-route-tester-supplement.test.ts` (10 tests,
independent of the Coder's `songs-route.test.ts`) covering behavior the
Coder's own suite did not exercise:

- **Route wiring**: `route.GET`/`route.POST` delegate to the handler and
  return a `Response` without throwing.
- **Auth branches not covered by the Coder's suite**: Clerk `userId` null
  (401, before any DB call) for both GET and POST; `lookup` resolving to
  `null` — i.e. an authenticated Clerk user with no matching `users` row
  (401, before any DB call) for both GET and POST. The Coder's suite only
  exercised the "no JWT" 401 path, not these two.
- **Defense-in-depth scoping**: GET's select chain is asserted to call
  `.eq("church_group_id", CHURCH_GROUP_ID)`, not just to return 200.
- **Trim-before-BR-09-check edge case**: `default_key: " C "` → 201, stored
  as the trimmed `"C"`; `default_key: " H "` → still 422 (trimming happens
  in Zod before the handler's `isValidSongKey` check, so padding can't be
  used to dodge either the valid or invalid paths).
- **Unknown body fields are dropped, not stored or rejected** — e.g.
  `spotify_id` sent in the POST body is confirmed absent from the insert
  payload (the spec requires `spotify_id` stay server-controlled/null,
  manual entry only; a client trying to smuggle it in must not succeed).

All 10 new tests pass. One lint warning surfaced during this stage's own
test authoring (an unused `SongResponse` type import) — fixed directly in
the new test file (a Tester-owned file, not the Coder's code), and
`bun run lint` is clean again after the fix.

## Manual verification of spec edge cases

Cross-checked every edge case enumerated in `.pipeline/spec.md` ("Edge
cases the implementation MUST handle") against the Coder's
`songs-route.test.ts` and confirmed each one has a corresponding assertion:
all GET cases (no `q`, `q` filter, empty `q`, empty catalog, `tags` null →
`[]`, guest → 403, no JWT → 401, DB error → 500) and all POST cases (minimal
valid body, ASCII/Unicode valid keys, omitted/invalid key → 422 for `H`,
`c#`, `Cmaj`, `Z`, `bb`, missing/whitespace/oversized title → 400, oversized
artist → 400 / omitted → 201, `bpm` bounds/omission, `tags` shape/empty,
malformed JSON body → 400, role gating member/guest → 403 vs admin/set_leader
→ 201, no JWT → 401, insert error → 500) are all present and pass.

## Failure cases confirmed

The BR-09 negative path (`it.each(["H", "c#", "Cmaj", "Z", "bb"])` → 422
VALIDATION_FAILED) and the 500-on-DB-error / 500-on-insert-error cases are
genuine failure-path tests, independently re-run and passing. This stage's
own added failure cases (401 for unauthenticated/unprovisioned users on
both endpoints, and confirming smuggled `spotify_id`/unknown fields don't
reach the insert payload) also pass.

## Verdict

**PASS.** 51 test suites / 579 tests green, lint clean, typecheck clean.
No discrepancies found between `.pipeline/spec.md`, `.pipeline/changes.md`,
and the actual diff. Ready for Review.
