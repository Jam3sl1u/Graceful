# Changes — Issue #58: Song-level document attachment (signed URLs)

Implements the four song-document endpoints (previously 501 stubs) and the R2
presigned-URL helpers they depend on, per `.pipeline/spec.md`. No migrations
touched (table/RLS already exist) and no new dependencies added
(`@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` were already present).

## Files created

- **`schemas/song-documents.ts`** — `uploadUrlSchema` (name/file_type/
  file_size_bytes shape validation) and `registerDocumentSchema` (extends it
  with `file_key`). Mirrors `schemas/songs.ts` style.

- **`app/api/songs/[id]/documents/handler.ts`** — single module exporting
  `createUploadUrl`, `registerDocument`, `listDocuments`, `deleteDocument`,
  all mirroring the auth → role → jwt/getToken → getSupabaseClient → query →
  `ok`/`fail` boilerplate from `app/api/songs/handler.ts`, wrapped in
  try/catch mapping `ApiException` (R2 SDK errors are plain `Error`s and fall
  through to the generic 500 branch).
  - Shared `songExistsInGroup` helper checks the song belongs to the caller's
    `church_group_id` *before* any R2 or document DB work (404 NOT_FOUND if
    absent) — enforced first in every one of the four functions, right after
    the JWT is resolved.
  - `createUploadUrl` (role `admin`/`set_leader`): mints
    `song-documents/{churchGroupId}/{songId}/{uuid}/{sanitizedName}` as the
    `file_key`, calls `getUploadUrl(fileKey, file_type)`, returns
    `{ uploadUrl, fileKey }`.
  - `registerDocument` (role `admin`/`set_leader`): rejects a `file_key` not
    prefixed with `song-documents/{churchGroupId}/{songId}/` (400
    VALIDATION_FAILED, prevents registering another group's/song's object),
    inserts the metadata row, signs the inserted `file_key` with
    `getDownloadUrl`, returns `{ document }` (201) with the full DTO — the
    raw `file_key` is never included in the response.
  - `listDocuments` (role `admin`/`set_leader`/`member` — guests excluded):
    selects rows ordered by `created_at` ascending, maps each to the DTO by
    signing `file_key` via `getDownloadUrl`; empty group/song → `{ documents:
    [] }`.
  - `deleteDocument` (role `admin`/`set_leader`): three-way scoped delete
    (`id` + `song_id` + `church_group_id`) chained with `.select("id")`; an
    empty result set (wrong doc/song/group) → 404 NOT_FOUND. R2 object
    cleanup intentionally out of scope per spec.

- **`tests/unit/app/api/song-documents-route.test.ts`** (new — not explicitly
  listed under the spec's "Files to create" but the spec's "Patterns to
  copy" section calls for handler tests following
  `tests/unit/app/api/songs-route.test.ts`'s harness, additionally mocking
  `@/lib/r2/client`). 35 tests covering the happy path, all four
  role/permission gates, the song-not-in-group 404 (and that it fires before
  any R2/DB write call), body validation (missing/malformed, non-integer/
  zero/negative/float `file_size_bytes`), the `file_key` prefix guard (three
  malformed-prefix cases), the empty-list case, the 3-way-scoped-delete-miss
  404, unauth 401 (JWT missing), and R2/Supabase failure paths → 500
  INTERNAL.

## Files modified

- **`lib/r2/client.ts`** — replaced the two throwing stubs with real
  presigned-URL generation via `@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner`. Lazy singleton `S3Client` built from
  `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`
  (`region: "auto"`, `forcePathStyle: true`); throws a plain `Error` if any
  is missing (surfaces as 500 via the handler's generic catch). Both
  `getUploadUrl` (now takes an optional `contentType`) and `getDownloadUrl`
  use a 30-minute expiry (`SIGNED_URL_EXPIRY_SECONDS = 30 * 60`). Removed the
  stale `Sprint 3 #58` TODO comment.

- **`app/api/songs/[id]/documents/route.ts`**,
  **`app/api/songs/[id]/documents/upload-url/route.ts`**,
  **`app/api/songs/[id]/documents/[docId]/route.ts`** — replaced the
  `notImplemented` 501 stubs with thin wiring to the new handler functions,
  unwrapping `params: Promise<{...}>` the same way as
  `app/api/service-weeks/[id]/route.ts`.

- **`lib/supabase/types.ts`** — added `SongDocumentsRow` and a `song_documents`
  entry to the hand-rolled `Database["public"]["Tables"]` type (Insert omits
  `id`/`created_at`/`uploaded_by` as optional, matching the `songs` table's
  style for DB-defaulted/nullable columns).

## Out of scope (untouched, per spec)

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 52 suites / 615 tests pass, including the 35 new
  song-documents tests.

## What the Tester should focus on

- Role gates for all four endpoints (spec's exact matrix: list allows
  `member`, the other three do not).
- The song-in-group 404 guard firing *before* any R2 call (assert
  `getUploadUrl`/`getDownloadUrl` were never invoked in that path) and before
  any DB insert/delete.
- The `file_key` prefix check in `registerDocument` — confirm a `file_key`
  scoped to a different group or a different song within the same group is
  rejected (400), not just a totally unrelated key.
- `file_size_bytes` edge cases (0, negative, float, non-numeric string) all
  400.
- The delete 3-way scope: a `docId` that exists but under a different
  `song_id` or `church_group_id` must 404, not silently no-op-succeed.
- Response shape: `file_key` must never leak in `listDocuments` /
  `registerDocument` responses — only `downloadUrl`.
- `lib/r2/client.ts`'s missing-env-var throw path is only exercised
  indirectly here (mocked out in the handler tests) — if there's a
  standalone R2-client unit test worth adding, verify the throw message and
  that a present-but-empty-string env var also counts as "missing".
