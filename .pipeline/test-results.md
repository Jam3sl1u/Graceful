# Test Results — Issue #58: Song-level document attachment (signed URLs)

This overwrites the stale `test-results.md` for issue #53 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Summary

**PASS.** All verification commands are clean and the coder's claims in
`.pipeline/changes.md` hold up under independent re-verification. One gap
noted in changes.md ("What the Tester should focus on") — no standalone
`lib/r2/client.ts` unit test existed — has been filled in with a new test
file; it passes.

## Commands re-run independently

- `bun run lint` — clean, 0 errors / 0 warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run test` — **53 suites / 628 tests pass** (52 suites / 615 tests from
  the coder's existing work, plus 1 new suite / 13 new tests added by this
  stage).

## Independent code read

Read `schemas/song-documents.ts`, `app/api/songs/[id]/documents/handler.ts`,
`lib/r2/client.ts`, the three `route.ts` wiring files
(`app/api/songs/[id]/documents/route.ts`, `.../upload-url/route.ts`,
`.../[docId]/route.ts`), and the `song_documents` table registration in
`lib/supabase/types.ts` against `.pipeline/spec.md` line by line. Confirmed:

- Role matrix matches spec exactly: `createUploadUrl`/`registerDocument`/
  `deleteDocument` → `["admin", "set_leader"]`; `listDocuments` →
  `["admin", "set_leader", "member"]` (guest excluded everywhere).
- `songExistsInGroup` runs before any R2 call and before any DB insert/delete
  in all four functions; existing tests assert `getUploadUrl`/`getDownloadUrl`
  are never invoked on the 404 path (`expect(mockGetUploadUrl).not.toHaveBeenCalled()`),
  and forbidden roles never reach `getSupabaseClient`
  (`expect(mockGetSupabaseClient).not.toHaveBeenCalled()`).
- `file_key` prefix check in `registerDocument` rejects all three malformed
  cases the spec calls out: an unrelated key, another group's key, and
  another song's key within the same group — confirmed via
  `tests/unit/app/api/song-documents-route.test.ts`'s
  `it.each(["not-prefixed/at/all.pdf", "song-documents/other-group/...", "song-documents/${group}/other-song/..."])`.
- `file_size_bytes` edge cases (`0`, `-1`, `1.5`, `"2048"` string) all 400 —
  matches `uploadUrlSchema`'s `z.number().int().positive()`.
- Delete's 3-way scope (`id` + `song_id` + `church_group_id`) returns 404 on
  an empty result set rather than silently no-op-succeeding — confirmed in
  code and test (`delete: { data: [], error: null }` → 404 NOT_FOUND).
- Response DTOs never leak the raw `file_key`: `listDocuments` and
  `registerDocument` select `file_key` only to sign it via `getDownloadUrl`,
  and the mapped `SongDocumentResponse` omits it; tests assert
  `expect(document).not.toHaveProperty("fileKey")` /
  `not.toHaveProperty("file_key")`.
- 401/403 ordering matches the spec and the songs-handler pattern: role check
  (`requireRole`) happens before the JWT fetch, so a forbidden role never
  reaches Supabase, and a missing JWT short-circuits before any Supabase call.
- `lib/r2/client.ts` matches the spec's exact shape: lazy singleton `S3Client`
  (`region: "auto"`, `forcePathStyle: true`), 30-minute
  (`SIGNED_URL_EXPIRY_SECONDS = 30 * 60`) expiry on both `getUploadUrl` and
  `getDownloadUrl`, optional `contentType` param, throws a plain `Error` if
  any of `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`
  is missing. The stale `Sprint 3 #58` TODO comment is gone, as claimed.
- `lib/supabase/types.ts`'s new `SongDocumentsRow` / `song_documents` Tables
  entry matches the spec's exact shape (`Insert` omits `id`/`created_at`/
  `uploaded_by` as optional, matching the `songs` table's style).
- Route wiring files correctly unwrap `params: Promise<{...}>` and delegate
  straight to the handler functions with no extra logic, matching
  `app/api/service-weeks/[id]/route.ts`'s pattern.
- No migrations were added/modified and no new dependencies were introduced,
  per the spec's explicit "do NOT" constraints — `git status` shows only the
  files `changes.md` lists as created/modified, plus the one new test file
  added by this stage.

## New tests written by this stage

**`tests/unit/lib/r2/client.test.ts`** (13 tests, new) — fills the gap the
coder flagged in changes.md ("What the Tester should focus on"): a
standalone unit test for `lib/r2/client.ts` that mocks `@aws-sdk/client-s3`
and `@aws-sdk/s3-request-presigner` directly (no handler indirection), using
`jest.isolateModulesAsync` per test to get a fresh lazy-singleton `S3Client`
each time. Covers:

- `getUploadUrl` signs a `PutObjectCommand` with the correct
  `Bucket`/`Key`/`ContentType` and a 30-minute (`1800`s) `expiresIn`.
- `getUploadUrl` works with `contentType` omitted (optional param).
- `getDownloadUrl` signs a `GetObjectCommand` with the correct
  `Bucket`/`Key` and the same 30-minute expiry.
- Each of the four required env vars (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`), when **missing**, throws
  `/R2 is not configured/` and never calls `getSignedUrl`.
- Each of the four required env vars, when **present but an empty string**,
  also throws — confirms `!endpoint` etc. treats `""` as falsy/missing, not
  just `undefined`. This was explicitly called out as unverified in
  changes.md and is now covered.
- The `S3Client` singleton is constructed exactly once across two calls
  (`getUploadUrl` then `getDownloadUrl`) with the exact expected config
  (`region: "auto"`, `endpoint`, `forcePathStyle: true`, `credentials`).

All 13 pass; `bun run lint` / `bun run typecheck` remain clean with the new
file included.

## Manual verification of spec edge cases

Cross-checked every edge case enumerated in `.pipeline/spec.md` ("Edge cases
the implementation must handle") against the coder's
`tests/unit/app/api/song-documents-route.test.ts` and confirmed each has a
corresponding, passing assertion: unauthenticated 401 (before Supabase/R2
touch) for all four endpoints; role gating per-endpoint (list allows
`member`, others don't; `guest` always 403); song-not-in-group 404 (before
R2 signing and before insert/delete) for all four; malformed/missing JSON
body → 400; `file_size_bytes` invalid (non-number/0/negative/float) → 400;
`file_key` prefix mismatch (3 variants) → 400; empty document list → 200
`{ documents: [] }`; delete-miss (wrong doc/song/group) → 404; Supabase
query/insert/delete errors → 500; R2 helper throwing → 500 INTERNAL.

## Failure cases exercised

Per the pipeline contract's requirement to cover at least one failure case,
the following were independently confirmed (both pre-existing in the
coder's suite and newly added by this stage):

- R2 SDK throwing (e.g. `getUploadUrl` rejecting) is caught by the handler's
  generic `catch (err)` and surfaces as 500 INTERNAL, not an unhandled
  rejection (`tests/unit/app/api/song-documents-route.test.ts`, "returns 500
  INTERNAL when the R2 helper throws").
- `lib/r2/client.ts` itself throwing synchronously on missing/empty env vars,
  verified independently of the handler's mocking (new
  `tests/unit/lib/r2/client.test.ts`).
- Supabase insert/list/delete query errors all map to 500 INTERNAL in their
  respective handler functions (pre-existing tests, re-run and confirmed).

## Verdict

No failures found. Nothing was patched around — the implementation matched
the spec on every point checked, and the one coverage gap the coder itself
flagged is now closed. Ready for Review.
