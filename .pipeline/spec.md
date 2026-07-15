# Spec — Issue #58: Song-level document attachment (signed URLs)

No OPEN QUESTIONS. Two decisions were forced by the DB schema / PRD and are
documented under "Decisions" below rather than blocked — they are defensible and
deterministic; a human/reviewer can override if wrong.

None blocking. Non-blocking decisions made below (see "Decisions / assumptions")
are the obvious reading of the issue + PRD security baseline; downstream stages
should proceed on them, not stop.

## Summary

Implement the four song-document endpoints that are currently 501 stubs, plus
the two R2 presigned-URL helpers they depend on. The DB table `song_documents`,
its indexes, and its tenant-scoped RLS policies already exist (migrations
`20260702000004_cluster_4_partial_songs.sql` and `20260704000001_rls_policies.sql`
— do NOT add or modify migrations). The `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner` packages are already in `package.json` — do NOT
add dependencies.

Flow is a standard two-step signed upload:
1. Client asks for a presigned PUT URL (server mints the `file_key`).
2. Client PUTs the bytes straight to R2.
3. Client registers the completed upload (metadata row in `song_documents`).
4. List returns each doc with a fresh presigned GET URL (30-min expiry).
5. Delete removes the metadata row.

## Table already in DB (for reference — do not create)

`song_documents`: `id uuid pk`, `song_id uuid not null → songs(id) on delete cascade`,
`church_group_id uuid not null → church_groups(id)`, `name varchar(200) not null`,
`file_key text not null`, `file_type varchar(50) not null`,
`file_size_bytes integer not null`, `uploaded_by uuid → users(id) on delete set null`,
`created_at timestamptz not null default now()`. RLS is tenant-scoped on
`church_group_id` for select/insert/update/delete (all authenticated).

## Files to create

### 1. `schemas/song-documents.ts` (new)
Follow the style of `schemas/songs.ts`.

```ts
import { z } from "zod";

// Body for POST /api/songs/:id/documents/upload-url
export const uploadUrlSchema = z.object({
  name: z.string().trim().min(1).max(200),
  file_type: z.string().trim().min(1).max(50),
  file_size_bytes: z.number().int().positive().max(2147483647), // int4 column bound
});
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;

// Body for POST /api/songs/:id/documents (register completed upload)
export const registerDocumentSchema = uploadUrlSchema.extend({
  file_key: z.string().trim().min(1).max(1024),
});
export type RegisterDocumentInput = z.infer<typeof registerDocumentSchema>;
```

### 2. `app/api/songs/[id]/documents/handler.ts` (new)
Single handler module for all four operations. Model it on
`app/api/songs/handler.ts` (auth → role → jwt/getToken → getSupabaseClient →
query → `ok`/`fail`, wrapped in try/catch that maps `ApiException`). Import the
R2 helpers from `@/lib/r2/client` so tests can mock that module.

Response DTO:
```ts
export type SongDocumentResponse = {
  id: string;
  songId: string;
  name: string;
  fileType: string;
  fileSizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
  downloadUrl: string; // presigned GET, 30-min expiry
};
```

Exported functions (each mirrors the songs handler's auth/jwt boilerplate):

```ts
export async function createUploadUrl(req: NextRequest, songId: string, lookup?: UserLookup): Promise<Response>;
export async function registerDocument(req: NextRequest, songId: string, lookup?: UserLookup): Promise<Response>;
export async function listDocuments(req: NextRequest, songId: string, lookup?: UserLookup): Promise<Response>;
export async function deleteDocument(req: NextRequest, songId: string, docId: string, lookup?: UserLookup): Promise<Response>;
```

Shared internal helper — verify the song exists in the caller's group BEFORE any
R2 or document work (satisfies the issue's "belongs to the church group" guard).
Query the RLS-scoped client:
```ts
// returns true if a row exists for songId within ctx.churchGroupId
const { data } = await supabase
  .from("songs")
  .select("id")
  .eq("id", songId)
  .eq("church_group_id", ctx.churchGroupId)
  .maybeSingle();
```
If absent → `fail("Song not found", ErrorCode.NOT_FOUND, 404)`.

`file_key` generation (used only in `createUploadUrl`):
```ts
const safeName = input.name.replace(/[^A-Za-z0-9._-]/g, "_");
const fileKey = `song-documents/${ctx.churchGroupId}/${songId}/${crypto.randomUUID()}/${safeName}`;
```
Use the global `crypto.randomUUID()` (available in the Next.js runtime; no import).

Per-function behavior:

- **createUploadUrl** — role `["admin", "set_leader"]`. Parse body with
  `uploadUrlSchema` (invalid → 400 VALIDATION_FAILED). Verify song-in-group
  (else 404). Build `fileKey` as above. Call
  `getUploadUrl(fileKey, input.file_type)`. Return
  `ok({ uploadUrl, fileKey }, 200)`.

- **registerDocument** — role `["admin", "set_leader"]`. Parse body with
  `registerDocumentSchema` (invalid → 400). Verify song-in-group (else 404).
  Reject a `file_key` the client didn't get from us: require
  `input.file_key.startsWith(\`song-documents/${ctx.churchGroupId}/${songId}/\`)`
  — else `fail("Invalid file key", ErrorCode.VALIDATION_FAILED, 400)`. Insert
  into `song_documents`:
  ```ts
  const payload = {
    song_id: songId,
    church_group_id: ctx.churchGroupId,
    name: input.name,
    file_key: input.file_key,
    file_type: input.file_type,
    file_size_bytes: input.file_size_bytes,
    uploaded_by: ctx.userId,
  } as unknown as Database["public"]["Tables"]["song_documents"]["Insert"];
  ```
  Select back `id, song_id, name, file_key, file_type, file_size_bytes,
  uploaded_by, created_at` with `.single()`. On error/no data → 500 INTERNAL.
  Sign the inserted `file_key` with `getDownloadUrl` and return
  `ok({ document: <full DTO incl. downloadUrl> }, 201)`.

- **listDocuments** — role `["admin", "set_leader", "member"]` (musicians must
  read; guests excluded). Verify song-in-group (else 404). Query:
  ```ts
  supabase.from("song_documents")
    .select("id, song_id, name, file_key, file_type, file_size_bytes, uploaded_by, created_at")
    .eq("song_id", songId)
    .eq("church_group_id", ctx.churchGroupId)
    .order("created_at", { ascending: true });
  ```
  On error → 500. Map each row → DTO, calling `await getDownloadUrl(row.file_key)`
  per row. Do NOT include the raw `file_key` in the response DTO (it's selected
  only so it can be signed). Return `ok({ documents: [...] }, 200)`. Empty group
  → `{ documents: [] }`.

- **deleteDocument** — role `["admin", "set_leader"]`. Verify song-in-group
  (else 404). Delete the row scoped to all three of `id = docId`,
  `song_id = songId`, `church_group_id = ctx.churchGroupId`; chain `.select("id")`
  after `.delete()` so a missing/foreign row comes back empty →
  `fail("Document not found", ErrorCode.NOT_FOUND, 404)`. On DB error → 500.
  Success → `ok({ success: true }, 200)`. (R2 object cleanup is out of scope —
  see decisions.)

## Files to modify

### 3. `lib/r2/client.ts`
Replace the two throwing stubs with real presigned-URL generation. Keep
`import "server-only";` and the exported names already referenced by callers, but
add an optional `contentType` param to `getUploadUrl`:

```ts
import "server-only";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_EXPIRY_SECONDS = 30 * 60; // 30 min (issue AC + #15 baseline)

// lazy singleton
let client: S3Client | null = null;
function getClient(): S3Client { /* build once from env, then reuse */ }

export async function getUploadUrl(key: string, contentType?: string): Promise<string>;
export async function getDownloadUrl(key: string): Promise<string>;
```

`getClient()` config: `region: "auto"`, `endpoint: process.env.R2_ENDPOINT`,
`forcePathStyle: true`, `credentials: { accessKeyId: R2_ACCESS_KEY_ID,
secretAccessKey: R2_SECRET_ACCESS_KEY }`. If any required env var
(`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) is
missing, throw a plain `Error` (surfaces as 500 via the handler try/catch).

- `getUploadUrl`: `getSignedUrl(getClient(), new PutObjectCommand({ Bucket:
  process.env.R2_BUCKET_NAME, Key: key, ContentType: contentType }), {
  expiresIn: SIGNED_URL_EXPIRY_SECONDS })`.
- `getDownloadUrl`: `getSignedUrl(getClient(), new GetObjectCommand({ Bucket:
  process.env.R2_BUCKET_NAME, Key: key }), { expiresIn: SIGNED_URL_EXPIRY_SECONDS })`.

Remove the stale `Sprint 3 #58` TODO comment.

### 4. `app/api/songs/[id]/documents/route.ts`
Replace stub. Wire params like `app/api/service-weeks/[id]/route.ts`:
```ts
type Ctx = { params: Promise<{ id: string }> };
export async function GET(req, { params }: Ctx) { const { id } = await params; return listDocuments(req, id); }
export async function POST(req, { params }: Ctx) { const { id } = await params; return registerDocument(req, id); }
```

### 5. `app/api/songs/[id]/documents/upload-url/route.ts`
Replace stub:
```ts
type Ctx = { params: Promise<{ id: string }> };
export async function POST(req, { params }: Ctx) { const { id } = await params; return createUploadUrl(req, id); }
```

### 6. `app/api/songs/[id]/documents/[docId]/route.ts`
Replace stub:
```ts
type Ctx = { params: Promise<{ id: string; docId: string }> };
export async function DELETE(req, { params }: Ctx) { const { id, docId } = await params; return deleteDocument(req, id, docId); }
```

### 7. `lib/supabase/types.ts`
`song_documents` is missing from the hand-rolled `Database` type. Add it,
matching the existing style (see `SongsRow` at line ~65 and the `songs` Tables
entry at line ~224).

Add a row type near `SongsRow`:
```ts
type SongDocumentsRow = {
  id: string;
  song_id: string;
  church_group_id: string;
  name: string;
  file_key: string;
  file_type: string;
  file_size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};
```
Add a Tables entry alongside `songs` (DB defaults `id`/`created_at`; `uploaded_by`
is nullable — mirror how `songs` marks defaulted/nullable columns optional):
```ts
song_documents: {
  Row: SongDocumentsRow;
  Insert: Omit<SongDocumentsRow, "id" | "created_at" | "uploaded_by"> & {
    id?: string;
    created_at?: string;
    uploaded_by?: string | null;
  };
  Update: Partial<SongDocumentsRow>;
  Relationships: [];
};
```

## Edge cases the implementation must handle

- Unauthenticated (no Clerk user, or `getToken` yields no supabase JWT) → 401
  UNAUTHENTICATED, and do not touch Supabase/R2. Order like the songs handler:
  role check runs before the JWT fetch, so forbidden roles never reach the DB.
- Wrong role → 403 FORBIDDEN before any DB/R2 call:
  - list: allowed `admin`/`set_leader`/`member`; `guest` → 403.
  - upload-url, register, delete: allowed `admin`/`set_leader`; `member`/`guest` → 403.
- Song id not in caller's group (or nonexistent) → 404 NOT_FOUND, checked before
  R2 signing and before insert/delete (the "belongs to the church group" guard).
- Malformed / missing JSON body, or fields failing the Zod shape → 400
  VALIDATION_FAILED. (`file_size_bytes` must be a positive integer; non-number,
  0, negative, or float → 400.)
- register with a `file_key` not prefixed by `song-documents/<group>/<song>/` →
  400 VALIDATION_FAILED (prevents registering an object from another group/song).
- delete of a docId that doesn't exist, belongs to another group, or belongs to a
  different song → 404 NOT_FOUND (the three-way scoped delete returns no rows).
- Empty document list → 200 with `{ documents: [] }`.
- Supabase query/insert/delete error → 500 INTERNAL.
- R2 helper throwing (missing env, SDK error) → caught by the handler try/catch →
  500 INTERNAL. (R2 errors are not `ApiException`, so they hit the generic 500
  branch — keep the existing `catch (err)` shape from songs handler.)

## Patterns to copy (name the file)

- Handler structure, auth/role/jwt boilerplate, `ok`/`fail`, `ApiException`
  mapping, and the `... as unknown as Database[...]["Insert"]` cast rationale:
  `app/api/songs/handler.ts`.
- Zod schema module style: `schemas/songs.ts`.
- Dynamic-route param unwrapping (`params: Promise<{...}>`, `await params`):
  `app/api/service-weeks/[id]/route.ts`.
- Unit-test harness (mock `@clerk/nextjs/server` + `@/lib/supabase/client`,
  chainable Supabase mock, `makeLookup(role)`, `setUpAuth`):
  `tests/unit/app/api/songs-route.test.ts`. New handler tests additionally mock
  `@/lib/r2/client` (`jest.mock("@/lib/r2/client", () => ({ getUploadUrl: jest.fn(),
  getDownloadUrl: jest.fn() }))`) so no real AWS SDK/network is involved.

## Decisions / assumptions (non-blocking)

- **Attach roles**: acceptance criteria only pin DELETE to Set Leader/Admin.
  upload-url + register are given the same `admin`/`set_leader` restriction (the
  goal is a Set Leader attaching); list is opened to `member` so musicians can
  read their charts. Guests are excluded everywhere.
- **Expiry**: 30 minutes (1800s) for BOTH upload and download URLs — matches the
  read-URL AC and #15's baseline; the R2 stub's own TODO already specified 30-min.
- **No content-type allowlist / product file-size cap**: not requested by the
  issue. Validation is shape-only (`file_type` a non-empty ≤50-char string,
  `file_size_bytes` a positive int within the int4 column bound). Do not invent
  an allowlist or a business size limit.
- **R2 object deletion on DELETE**: out of scope. DELETE removes the
  `song_documents` metadata row only (the AC is "removes an attachment"). Do not
  add an R2 delete helper.
- **No new migrations, no dependency changes, no public bucket access** — all
  access is via short-lived presigned URLs generated server-side only after the
  auth + group + song-ownership checks (PRD §15.2).

## Verify before finishing (Coding stage)

`bun run lint`, `bun run typecheck`, `bun run test`.
