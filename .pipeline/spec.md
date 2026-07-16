# Spec — Issue #55: Add/remove/reorder setlist songs (BR-07 no duplicates)

## OPEN QUESTIONS

None blocking. Two forced-but-defensible decisions are documented under
"Decisions (non-blocking)" below (PUT body shape and the "unlocked-published"
guard). They are the obvious reading of the issue + PRD given the current DB
schema; downstream stages should proceed on them, not stop.

## Summary

Implement three currently-stubbed endpoints for editing a draft setlist's songs:

- `PUT /api/setlists/:id` — reorder songs + set key overrides.
- `POST /api/setlists/:id/songs` — add one song (BR-07: reject duplicates).
- `DELETE /api/setlists/:id/songs/:songId` — remove a song, recompact positions.

All three are Set Leader / Admin only, tenant-scoped, and operate only on a
setlist whose `status = 'draft'`. The DB tables (`setlists`, `setlist_songs`),
their FK/unique constraints, and RLS policies already exist — **do NOT add or
modify any migration.** The stubs today return 501 via `notImplemented`.

`setlist_songs` has NO `church_group_id` column. Tenant scoping is done by first
loading the parent `setlists` row filtered on `id` + `church_group_id`; RLS on
`setlist_songs` enforces the same via a join, but the explicit parent lookup is
what gives correct 404 semantics.

## Current state (verified, for reference — do not recreate)

- `setlist_songs` columns (migration `20260702000003_cluster_3_scheduling_core.sql`):
  `id uuid pk`, `setlist_id uuid not null → setlists(id) on delete cascade`,
  `song_id uuid not null → songs(id)` (FK added in `20260714000001`),
  `position integer not null`, `key_override varchar(5)`, `notes text`,
  `unique (setlist_id, song_id)`. No unique constraint on `(setlist_id, position)`.
- `setlists` columns include `status setlist_status not null default 'draft'` and
  `church_group_id`. `SetlistStatus = "draft" | "published"`.
- Routes to fill are all `notImplemented` stubs:
  - `app/api/setlists/[id]/route.ts` (`PUT`)
  - `app/api/setlists/[id]/songs/route.ts` (`POST`)
  - `app/api/setlists/[id]/songs/[songId]/route.ts` (`DELETE`)
- There is NO `app/api/setlists/[id]/handler.ts` yet — create it.
- `schemas/setlists.ts` is a placeholder (`z.object({})`) — replace its contents.
- `setlist_songs` is MISSING from the hand-rolled `Database` type in
  `lib/supabase/types.ts` — add it.
- `isValidSongKey` (BR-09) is exported from `schemas/songs.ts` — reuse it, do
  not re-list keys.

## Files to modify / create

### 1. `schemas/setlists.ts` (replace placeholder contents)

Follow the style of `schemas/songs.ts`. Shape-only validation; key-membership
(BR-09) is checked in the handler so it can return 422 (not 400).

```ts
import { z } from "zod";

// PUT /api/setlists/:id — full desired order of the songs already in the
// setlist. Position is derived from array index (1-indexed); it is NOT sent by
// the client. keyOverride null clears any override.
export const reorderSetlistSchema = z.object({
  songs: z
    .array(
      z.object({
        songId: z.string().uuid(),
        keyOverride: z.string().trim().min(1).max(5).nullish(),
      }),
    ),
});
export type ReorderSetlistInput = z.infer<typeof reorderSetlistSchema>;

// POST /api/setlists/:id/songs — add one song.
export const addSetlistSongSchema = z.object({
  songId: z.string().uuid(),
  keyOverride: z.string().trim().min(1).max(5).nullish(),
});
export type AddSetlistSongInput = z.infer<typeof addSetlistSongSchema>;
```

Remove the stale `TODO(Sprint 3 #45-48)` placeholder export.

### 2. `lib/supabase/types.ts` (add `setlist_songs`)

Add a row type next to `SetlistsRow` (~line 115):

```ts
type SetlistSongsRow = {
  id: string;
  setlist_id: string;
  song_id: string;
  position: number;
  key_override: string | null;
  notes: string | null;
};
```

Add a Tables entry next to the `setlists` entry (~line 280). `id` is
DB-defaulted; `key_override` and `notes` are nullable:

```ts
setlist_songs: {
  Row: SetlistSongsRow;
  Insert: Omit<SetlistSongsRow, "id" | "key_override" | "notes"> & {
    id?: string;
    key_override?: string | null;
    notes?: string | null;
  };
  Update: Partial<SetlistSongsRow>;
  Relationships: [];
};
```

### 3. `app/api/setlists/[id]/handler.ts` (new)

Model it on `app/api/service-weeks/[id]/setlist/handler.ts` and
`app/api/songs/handler.ts`: `requireAuth` → `requireRole` → `getToken({ template:
"supabase" })` (null → 401) → `getSupabaseClient(jwt)` → queries → `ok`/`fail`,
all wrapped in the same `try/catch` that maps `ApiException` and otherwise
returns 500. Import `isValidSongKey` from `@/schemas/songs`.

Response DTO + mapper:

```ts
type SetlistSongsRow = Database["public"]["Tables"]["setlist_songs"]["Row"];

export type SetlistSongResponse = {
  id: string;
  setlistId: string;
  songId: string;
  position: number;
  keyOverride: string | null;
  notes: string | null;
};

export function toSetlistSongResponse(row: SetlistSongsRow): SetlistSongResponse {
  return {
    id: row.id,
    setlistId: row.setlist_id,
    songId: row.song_id,
    position: row.position,
    keyOverride: row.key_override,
    notes: row.notes,
  };
}
```

Shared internal helper — load the parent setlist tenant-scoped and assert it is
editable. Use it at the top of all three handlers (after JWT):

```ts
// Returns the setlist row, or a Response to return early (404 if missing/other
// tenant, 409 if not a draft). Query:
//   supabase.from("setlists").select("id, status")
//     .eq("id", setlistId).eq("church_group_id", ctx.churchGroupId).maybeSingle()
// error → 500; no data → 404 "Setlist not found";
// data.status !== "draft" → 409 CONFLICT
//   "Setlist is published. Unlock it before editing." (see Decisions)
```

Exported functions:

```ts
export async function reorderSetlist(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>;
export async function addSetlistSong(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>;
export async function removeSetlistSong(req: NextRequest, id: string, songId: string, lookup?: UserLookup): Promise<Response>;
```

Role for all three: `requireRole(ctx, ["admin", "set_leader"])`.

Every handler returns the full, freshly-read, position-ordered song list on
success: `ok({ songs: rows.map(toSetlistSongResponse) }, <status>)`.

**`reorderSetlist` (PUT, success 200):**
1. Parse body with `reorderSetlistSchema` (invalid/malformed JSON → 400
   VALIDATION_FAILED — use `await req.json().catch(() => null)`).
2. For each `songs[i].keyOverride` that is non-null, `isValidSongKey(...)` → else
   422 VALIDATION_FAILED "Invalid musical key".
3. Editable-setlist guard (helper above).
4. Reject duplicate `songId` values within the request body → 400
   VALIDATION_FAILED.
5. Load current setlist_songs: `.select("id, song_id").eq("setlist_id", id)`.
   The set of `songId`s in the body MUST equal the set of current `song_id`s
   exactly (same length, same members — no adds, no removes via PUT). If not →
   400 VALIDATION_FAILED "Song set does not match the setlist" (adds/removes go
   through POST/DELETE).
6. For each body entry at index `i`, update its matching setlist_songs row
   (matched by `song_id`, scoped `.eq("setlist_id", id)`) setting
   `position: i + 1` and `key_override: entry.keyOverride ?? null`. Any update
   error → 500.
7. Re-select all rows ordered by `position` asc and return them.

**`addSetlistSong` (POST, success 201):**
1. Parse body with `addSetlistSongSchema` (invalid → 400).
2. If `keyOverride` non-null and `!isValidSongKey(keyOverride)` → 422.
3. Editable-setlist guard.
4. Verify the song exists in the caller's group (prevents cross-tenant adds and
   gives a clean 404 rather than a raw FK error):
   `supabase.from("songs").select("id").eq("id", songId)
     .eq("church_group_id", ctx.churchGroupId).maybeSingle()` — missing → 404
   "Song not found".
5. **BR-07 duplicate check:** query existing setlist_songs for this setlist and
   song: `.select("id").eq("setlist_id", id).eq("song_id", songId).maybeSingle()`.
   If a row exists → `fail("That song is already in the setlist.",
   ErrorCode.CONFLICT, 409)`. (This mirrors the explicit pre-check pattern in
   `app/api/instruments/handler.ts`; the `unique (setlist_id, song_id)`
   constraint is the DB backstop.)
6. Compute next position = current count + 1 (positions are contiguous by
   invariant, so `existingRows.length + 1`). Determine count from a
   `.select("id").eq("setlist_id", id)` (or reuse step-5 data via a count).
7. Insert:
   ```ts
   const payload = {
     setlist_id: id,
     song_id: songId,
     position: nextPosition,
     key_override: parsed.keyOverride ?? null,
   } as unknown as Database["public"]["Tables"]["setlist_songs"]["Insert"];
   ```
   Insert error → if the Postgres unique-violation surfaces (song added
   concurrently) treat as 409 CONFLICT with the same BR-07 message; otherwise
   500. (Primary detection is the step-5 pre-check; this is just the race
   backstop.)
8. Re-select all rows ordered by `position` asc and return them (201).

**`removeSetlistSong` (DELETE, success 200):**
1. Editable-setlist guard (no request body).
2. Delete the row scoped to `setlist_id = id` AND `song_id = songId`, chaining
   `.select("id")` after `.delete()` so a missing/foreign row comes back empty →
   404 "Song not found in setlist". DB error → 500.
3. **Recompact positions:** re-select remaining rows
   `.select("id, position").eq("setlist_id", id).order("position", { ascending: true })`.
   For each remaining row at index `i`, if `row.position !== i + 1`, update that
   row's `position` to `i + 1` (scoped `.eq("id", row.id)`). Any update error →
   500. No `(setlist_id, position)` unique constraint exists, so intermediate
   states during sequential updates cannot collide.
4. Re-select all rows ordered by `position` asc and return them (200). Empty
   setlist → `{ songs: [] }`.

### 4. `app/api/setlists/[id]/route.ts` (replace stub)

```ts
import { NextRequest } from "next/server";
import { reorderSetlist } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return reorderSetlist(req, id);
}
```

### 5. `app/api/setlists/[id]/songs/route.ts` (replace stub)

```ts
import { NextRequest } from "next/server";
import { addSetlistSong } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return addSetlistSong(req, id);
}
```

### 6. `app/api/setlists/[id]/songs/[songId]/route.ts` (replace stub)

```ts
import { NextRequest } from "next/server";
import { removeSetlistSong } from "../../handler";

type Ctx = { params: Promise<{ id: string; songId: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id, songId } = await params;
  return removeSetlistSong(req, id, songId);
}
```

## Edge cases the implementation must handle

- Unauthenticated (no Clerk user, or `getToken` yields no supabase JWT) → 401
  UNAUTHENTICATED; do not touch Supabase. Order like the songs handler: role
  check runs before the JWT fetch, so forbidden roles never reach the DB.
- Wrong role (`member` / `guest`) → 403 FORBIDDEN before any DB call. All three
  mutations are `admin`/`set_leader` only.
- Setlist id missing, or belonging to another tenant → 404 NOT_FOUND (parent
  lookup filtered on `church_group_id`).
- Setlist `status = 'published'` → 409 CONFLICT (read-only until unlocked; see
  Decisions). Applies to all three mutations.
- Malformed / missing JSON body or fields failing the Zod shape → 400
  VALIDATION_FAILED. Non-null `keyOverride` failing BR-09 membership → 422.
- POST BR-07: adding a song already in the setlist → 409 CONFLICT with a clear
  message.
- POST with a `songId` not in the caller's group catalog → 404 "Song not found".
- PUT with a body whose songId set differs from the setlist's current songs, or
  containing duplicate songIds → 400 VALIDATION_FAILED.
- DELETE of a `songId` not in the setlist (or in another tenant's setlist) → 404.
- Position invariant: after POST, DELETE, and PUT the remaining rows are
  1-indexed and contiguous (`1..N`, no gaps). Empty setlist is valid (`{ songs: [] }`).
- Any Supabase query/insert/update/delete error → 500 INTERNAL.

## Patterns to copy (name the file)

- Handler structure, auth/role/JWT boilerplate, tenant-scoped parent lookup,
  `ok`/`fail`, `ApiException` mapping, and the
  `... as unknown as Database[...]["Insert"]` cast rationale:
  `app/api/service-weeks/[id]/setlist/handler.ts` and `app/api/songs/handler.ts`.
- Explicit duplicate pre-check → 409 CONFLICT: `app/api/instruments/handler.ts`.
- Dynamic-route param unwrapping (`params: Promise<{...}>`, `await params`):
  `app/api/service-weeks/[id]/setlist/route.ts`.
- Zod schema module style: `schemas/songs.ts` (and reuse its `isValidSongKey`).
- Unit-test harness (mock `@clerk/nextjs/server` + `@/lib/supabase/client`,
  chainable Supabase mock, `makeLookup(role)`, `setUpAuth`):
  `tests/unit/app/api/songs-route.test.ts`.

## Decisions (non-blocking)

- **PUT body shape.** The endpoint accepts `{ songs: [{ songId, keyOverride? }] }`
  representing the full desired order of songs already in the setlist; server
  assigns `position` from the array index (1-indexed). This makes "Position is
  1-indexed and contiguous after every mutation" hold by construction and keeps
  add/remove strictly in the POST/DELETE endpoints. Client does not send
  positions. Reviewer may override to an explicit-position payload if product
  wants partial updates, but that is not asked for by the issue.
- **"Draft only, or unlocked-published" guard.** The DB has no `locked` column;
  `setlist_status` is only `draft | published`, and unlock is issue #56 (out of
  scope here). The representable, defensible rule: mutations are allowed only
  when `status = 'draft'`; `published` → 409. PRD §21.4 line 1114 states a
  published setlist is read-only, so this is applied to all three mutations
  (not just PUT). When #56's unlock flips `published → draft`, these endpoints
  work unchanged. No `locked` column is invented.
- **Key-override validation returns 422** for a well-formed-but-invalid musical
  key, mirroring `createSong` (BR-09 reuse), while shape errors are 400.
- **`notes` on setlist_songs** is not settable through these endpoints (not in
  the AC); leave it as DB default / untouched.
- **`setlists.updated_at`** is not bumped by these mutations — not required by
  the AC; do not touch it.
- **No new migrations, no dependency changes, no scope creep** (publish #56 and
  per-song key validation beyond BR-09 are explicitly out of scope).

## Verify before finishing (Coding stage)

`bun run lint`, `bun run typecheck`, `bun run test`.
</content>
</invoke>
