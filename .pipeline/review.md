# Review — Issue #58: Song-level document attachment (signed URLs)

VERDICT: SHIP

## What I verified (firsthand, not just from the summaries)

- Ran `git diff main...HEAD` and read the actual source: `handler.ts`,
  `lib/r2/client.ts`, `schemas/song-documents.ts`, the three `route.ts`
  wiring files, and the `lib/supabase/types.ts` diff.
- Re-ran `bun run test` (53 suites / 628 tests pass), `bun run typecheck`
  (clean), `bun run lint` (clean) myself — not trusting the written report.
- Confirmed against the existing `app/api/songs/handler.ts` pattern that the
  auth/role/jwt ordering and `ok`/`fail`/`ApiException` handling match.

## Correctness / security assessment

- Role matrix is exactly per spec: upload-url / register / delete →
  `["admin","set_leader"]`; list → `["admin","set_leader","member"]`; guest
  excluded everywhere. `requireRole` (throws 403 FORBIDDEN) runs before the
  supabase JWT fetch, so forbidden roles never touch the DB/R2.
- `songExistsInGroup` runs before any R2 signing and before any insert/delete
  in all four functions — the "belongs to the church group" guard.
- `registerDocument` rejects a `file_key` not prefixed with
  `song-documents/<group>/<song>/` (400) — blocks cross-group/cross-song
  object registration. All DB queries are additionally `church_group_id`-scoped
  (defense in depth on top of RLS).
- Raw `file_key` never leaks in responses — selected only to sign via
  `getDownloadUrl`, then dropped from the DTO.
- Delete is 3-way scoped (`id`+`song_id`+`church_group_id`) with `.select("id")`
  → empty result maps to 404, not a silent no-op success.
- Presigned URLs: 30-min expiry on both PUT and GET; lazy singleton S3Client;
  throws plain `Error` on missing/empty required env var (surfaces as 500 via
  the generic catch). Matches spec exactly.
- No migrations added/modified, no new dependencies — spec's hard constraints
  honored.

## Tests are meaningful, not superficial

- 35 handler tests exercise every role gate, the pre-DB/pre-R2 404 ordering
  (asserting `getUploadUrl`/`getDownloadUrl`/`getSupabaseClient` were NOT
  called on rejected paths), the file_key prefix guard (3 malformed variants),
  `file_size_bytes` edge cases (0/negative/float/string), the empty-list case,
  the delete-miss 404, unauth 401, and R2/Supabase failure → 500.
- Tester added 13 standalone `lib/r2/client.ts` tests covering the
  present-but-empty-string env var falsy path and single-construction of the
  singleton — a real gap the coder flagged, now closed.

## Minor observations (non-blocking, no action required to ship)

1. `songExistsInGroup` destructures only `{ data }` and ignores `error`, so a
   DB error during the song lookup surfaces as 404 rather than 500. This is
   the exact shape the spec dictated, and the only observable difference is a
   404-vs-500 status on a rare infra error — acceptable.
2. The tester's new file `tests/unit/lib/r2/client.test.ts` is currently
   untracked in the worktree. The orchestrator's commit step must `git add`
   it so those 13 tests are actually captured in the PR; the code under review
   ships fine either way, but don't lose that file at commit time.

The implementation matches the spec on every point I checked, tests reflect
real behavior, and all gates are green under independent re-run. Ship it.
