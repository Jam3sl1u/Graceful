# Spec — Issue #53: Song catalog CRUD + search (BR-09 key validation)

## OPEN QUESTIONS

None blocking. One decision made explicitly (not a blocker):

- **Key representation (ASCII vs Unicode).** PRD §8 BR-09 (line 186 of
  `documentation/prd/graceful_requirements_v10.md`) enumerates the keys using
  Unicode musical symbols (`C♯`, `D♭`, …). Real JSON/HTTP clients send ASCII
  (`C#`, `Db`). To satisfy both the literal PRD list and practical clients,
  the accepted set below includes **both** the ASCII and Unicode spellings.
  The value is stored exactly as received (no normalization) — that is all
  this issue requires; a future transposition engine can normalize later.

## Scope

Implement the two `/api/songs` endpoints. Everything is at the API layer — the
`songs` table, its RLS policies (`songs_select_tenant`, `songs_insert_tenant`),
and the `varchar(5)` `default_key` column already exist (migrations
`20260702000004_cluster_4_partial_songs.sql` and `20260704000001_rls_policies.sql`).
**Do not add or modify any migration.** At 40–60 rows an RLS-scoped seq scan is
already well within the "reasonably fast" AC — no new DB index is required.

Out of scope (do not implement): Spotify enrichment/autocomplete, song
familiarity, per-song key override (#57), update/delete endpoints (issue only
asks for list/search + create), song documents (already exist elsewhere).

## Files to create / modify

### 1. `schemas/songs.ts` — REPLACE the placeholder

Currently just `z.object({})`. Replace with:

- A `VALID_SONG_KEYS` constant — a `ReadonlySet<string>` (or readonly array +
  Set) containing every accepted `default_key` string. Include the 17 ASCII
  spellings AND the 10 Unicode accidental spellings:

  ```
  ASCII:    C  C#  Db  D  D#  Eb  E  F  F#  Gb  G  G#  Ab  A  A#  Bb  B
  Unicode:  C♯  D♭  D♯  E♭  F♯  G♭  G♯  A♭  A♯  B♭
  ```

  (These represent the 12 chromatic pitch classes; no `E#`, `B#`, `Cb`, `Fb`.)
  Match is **case-sensitive and exact** (`Bb` valid, `bb`/`BB` invalid).
  Export a helper `isValidSongKey(key: string): boolean` returning
  `VALID_SONG_KEYS.has(key)`.

- `createSongSchema` — Zod object validating request-body **shape only** (NOT
  key membership; the key-value check happens in the handler so it can return
  422, see edge cases):
  - `title`: `z.string().trim().min(1).max(200)` (required)
  - `artist`: `z.string().trim().min(1).max(200).nullish()`
  - `default_key`: `z.string().trim().min(1).max(5).nullish()`
  - `bpm`: `z.number().int().positive().max(400).nullish()`
  - `tags`: `z.array(z.string().trim().min(1).max(50)).nullish()`
  - Unknown keys may be ignored (no `.strict()` needed).
  - Export `type CreateSongInput = z.infer<typeof createSongSchema>`.

- `songSearchQuerySchema` — for GET query params (parse from
  `Object.fromEntries(req.nextUrl.searchParams)`):
  - `q`: `z.string().trim().max(200).optional()` (search term)
  - Export `type SongSearchQuery = z.infer<typeof songSearchQuerySchema>`.

Follow `schemas/instruments.ts` + `schemas/audit-log.ts` for style.

### 2. `app/api/songs/handler.ts` — NEW FILE

Copy the structure/error-handling of `app/api/instruments/handler.ts` exactly
(same imports: `auth`, `requireAuth`, `requireRole`, `ok`, `fail`,
`ApiException`, `ErrorCode`, `getSupabaseClient`, `Database` type, plus the new
song schemas). Same JWT-fetch guard, same `try/catch` → `ApiException`/500
tail, same `as unknown as Database["public"]["Tables"]["songs"]["Insert"]`
narrow cast for the insert payload (the hand-rolled Insert type marks
`created_at` required despite the `now()` default — see the comment in
`instruments/handler.ts` lines 94-104).

Exports:

```ts
export type SongResponse = {
  id: string;
  title: string;
  artist: string | null;
  defaultKey: string | null;   // maps default_key
  bpm: number | null;
  tags: string[];              // [] when the column is null
  createdBy: string | null;    // maps created_by
  createdAt: string;           // maps created_at (ISO)
};

export async function listSongs(req: NextRequest, lookup?: UserLookup): Promise<Response>;
export async function createSong(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

Plus a private `toSongResponse(row)` mapper (snake_case row → `SongResponse`,
`tags: row.tags ?? []`).

**`listSongs` (GET /api/songs):**
- `requireAuth`, then `requireRole(ctx, ["admin", "set_leader", "member"])`
  (mirrors `app/api/church-group/members/handler.ts` — group members read the
  catalog; guests do not).
- Parse `songSearchQuerySchema` from `req.nextUrl.searchParams`; on failure →
  `fail("Validation failed", VALIDATION_FAILED, 400)`.
- Get JWT (401 if missing), build supabase client.
- Query: `supabase.from("songs").select("id, title, artist, default_key, bpm, tags, created_by, created_at")`.
  - RLS already scopes to the caller's church group. For defense-in-depth and
    consistency with the instruments handler you MAY also add
    `.eq("church_group_id", ctx.churchGroupId)`. Either is acceptable.
  - When `q` is present and non-empty: add
    `.or(\`title.ilike.%${q}%,artist.ilike.%${q}%\`)` for case-insensitive
    partial match across title and artist. When `q` is absent/empty: no filter.
  - `.order("title", { ascending: true })`.
- On error → 500 INTERNAL. Return `ok({ songs: (data ?? []).map(toSongResponse) })`.

**`createSong` (POST /api/songs):**
- `requireAuth`, then `requireRole(ctx, ["admin", "set_leader"])` — Set Leader /
  Admin only (403 FORBIDDEN otherwise; the guard runs before any DB call).
- `const body = await req.json().catch(() => null);` then
  `createSongSchema.safeParse(body)`; on failure →
  `fail("Validation failed", VALIDATION_FAILED, 400)`.
- **BR-09 key check (must produce 422):** if `parsed.default_key` is a
  non-null string and `!isValidSongKey(parsed.default_key)` →
  `fail("Invalid musical key", ErrorCode.VALIDATION_FAILED, 422)`.
  Membership runs only when `default_key` is present and non-null (omit/null
  skip the check). Keep this in the handler, NOT in Zod, so malformed body =
  400 but invalid key value = 422. Precedent for 422 + VALIDATION_FAILED:
  `app/api/church-group/members/[id]/handler.ts` lines 52-56.
- Get JWT (401 if missing), build supabase client.
- Insert payload (narrow cast as above):
  ```
  church_group_id: ctx.churchGroupId,
  title: parsed.title,
  artist: parsed.artist ?? null,
  default_key: parsed.default_key ?? null,
  bpm: parsed.bpm ?? null,
  tags: parsed.tags ?? null,
  created_by: ctx.userId,
  ```
  Do NOT set `spotify_id` (manual entry only; column stays null).
- `.insert(payload).select("id, title, artist, default_key, bpm, tags, created_by, created_at").single()`.
- On error/no data → 500 INTERNAL. Return `ok({ song: toSongResponse(data) }, 201)`.

No duplicate-title guard — the catalog legitimately allows same-titled songs
(different arrangements). Do NOT add the instruments-style 409 conflict check.

### 3. `app/api/songs/route.ts` — REWRITE

Replace the `notImplemented` stubs, mirroring `app/api/instruments/route.ts`:

```ts
import { NextRequest } from "next/server";
import { listSongs, createSong } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listSongs(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return createSong(req);
}
```

### 4. `lib/supabase/types.ts` — ADD the `songs` table

The `songs` table is not yet in the hand-rolled `Database` type. Add a
`SongsRow` type and register it in `Tables`, following the existing entries
(e.g. `instruments`, `service_weeks`):

```ts
type SongsRow = {
  id: string;
  church_group_id: string;
  title: string;
  artist: string | null;
  default_key: string | null;
  bpm: number | null;
  tags: string[] | null;
  spotify_id: string | null;
  created_by: string | null;
  created_at: string;
};
```

`Tables.songs`:
```ts
songs: {
  Row: SongsRow;
  Insert: Omit<
    SongsRow,
    "id" | "created_at" | "artist" | "default_key" | "bpm" | "tags" | "spotify_id" | "created_by"
  > & {
    id?: string;
    created_at?: string;
    artist?: string | null;
    default_key?: string | null;
    bpm?: number | null;
    tags?: string[] | null;
    spotify_id?: string | null;
    created_by?: string | null;
  };
  Update: Partial<SongsRow>;
  Relationships: [];
};
```

### 5. `tests/unit/app/api/songs-route.test.ts` — NEW FILE

Follow `tests/unit/app/api/instruments-route.test.ts` exactly (same mock
harness: `jest.mock("@clerk/nextjs/server")`, `jest.mock("@/lib/supabase/client")`,
`makeReq`, `makeLookup`, `setUpAuth`, `makeChain`/`makeSupabaseClient`). Add
`songs` to the fixtures. The chainable mock must also stub `.or(...)` and
`.ilike(...)` → return the chain (add `or: jest.fn(() => chain)` to `makeChain`;
`.order`/`.eq`/`.select`/`.single` are already there). GET reads searchParams,
so `makeReq` for GET must provide `nextUrl.searchParams` — build the request
with `new NextRequest("http://localhost/api/songs?q=...")` or stub
`{ nextUrl: { searchParams: new URLSearchParams("q=...") } }`. Cover the edge
cases below. (The Testing stage independently supplements this; the Coder must
still ship a passing suite.)

## Edge cases the implementation MUST handle

GET `/api/songs`:
- No `q` → returns all songs in the group (200), ordered by title.
- `q="amaz"` → case-insensitive partial match on title OR artist.
- Empty `q` (`?q=`) → treated as no filter (return all), not an error.
- Empty catalog → `200 { songs: [] }`.
- `tags` column null on a row → response `tags: []`.
- Caller role `guest` → 403 FORBIDDEN (before DB call).
- No JWT → 401 UNAUTHENTICATED (before `getSupabaseClient`).
- DB error → 500 INTERNAL.

POST `/api/songs`:
- Valid minimal body `{ title }` → 201, `artist/defaultKey/bpm` null, `tags: []`.
- Valid `default_key: "C#"` and `"Bb"` (ASCII) → 201, stored as sent.
- Valid Unicode `default_key: "D♭"` → 201.
- `default_key` omitted / null → 201 (allowed).
- Invalid `default_key` (`"H"`, `"c#"`, `"Cmaj"`, `"Z"`, `"bb"`) → **422**
  VALIDATION_FAILED (this is the BR-09 AC — must be 422, not 400).
- Missing/empty/whitespace `title` → 400 VALIDATION_FAILED.
- `title` > 200 chars → 400.
- `artist` > 200 chars → 400; `artist` omitted → 201.
- `bpm` non-integer, ≤ 0, or > 400 → 400; `bpm` omitted → 201.
- `tags` not an array / non-string elements → 400; `tags: []` → 201.
- Missing/malformed JSON body (`null`) → 400 VALIDATION_FAILED.
- Caller role `member` or `guest` → 403 FORBIDDEN (before DB call).
- `admin` and `set_leader` → allowed.
- No JWT → 401 UNAUTHENTICATED (before `getSupabaseClient`).
- Insert DB error / no data returned → 500 INTERNAL.

## Patterns to copy (named)

- Handler shape, auth/JWT guards, `try/catch` tail, narrow Insert cast:
  `app/api/instruments/handler.ts`.
- Role-gated read of the group catalog:
  `app/api/church-group/members/handler.ts` (`requireRole(["admin","set_leader","member"])`).
- Query-param Zod parse via `Object.fromEntries(req.nextUrl.searchParams)`:
  `app/api/church-group/audit-log/handler.ts` + `schemas/audit-log.ts`.
- 422 + VALIDATION_FAILED response:
  `app/api/church-group/members/[id]/handler.ts` (line ~52).
- Route wiring: `app/api/instruments/route.ts`.
- Unit-test harness: `tests/unit/app/api/instruments-route.test.ts`.

## Verify before finishing

`bun run lint`, `bun run typecheck`, and `bun run test` (Jest) must all pass.
Do not use `bun test` (native runner). Do not touch migrations or unrelated files.
