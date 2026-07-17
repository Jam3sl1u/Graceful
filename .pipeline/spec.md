# Spec — Issue #64: Build Setlist Builder screen

Two-panel Set Leader screen at `/setlists/[id]` (`[id]` = **setlist id**): left =
song search + quick-add; right = ordered setlist with per-song key/notes/drag/remove;
bottom bar = song count + Publish (with confirmation). Wires to the already-built
#55/#56/#57 endpoints, plus two small enabling backend changes noted below.

## OPEN QUESTIONS

None blocking. Two deliberate, low-risk decisions are called out inline (a new
read endpoint, and per-song notes persistence) — both are required to satisfy the
acceptance criteria and are speced concretely below rather than left ambiguous.

## Current state (verified)

- `app/(app)/setlists/[id]/page.tsx` is a stub: `<h1>Setlist Builder — coming soon</h1>`.
- Backend for editing already exists in `app/api/setlists/[id]/handler.ts`:
  - `POST /api/setlists/:id/songs` (`addSetlistSong`) — adds one song, BR-07 dup → 409, returns `{ songs }` (201).
  - `DELETE /api/setlists/:id/songs/:songId` (`removeSetlistSong`) — removes + recompacts positions, returns `{ songs }`.
  - `PUT /api/setlists/:id` (`reorderSetlist`) — full reorder + key overrides, returns `{ songs }`. Body must contain **exactly** the setlist's current song set; position is derived from array index (1-based). Editing 409s if the setlist is published.
  - `POST /api/setlists/:id/publish` (`publishSetlist`) — draft→published, BR-01 zero songs is valid.
  - `POST /api/setlists/:id/unlock` (`unlockSetlist`) — published→draft.
- `GET /api/songs?q=` (`listSongs`) returns the whole catalog (`{ songs: [{id,title,artist,defaultKey,bpm,tags,...}] }`), optional case-insensitive title/artist filter. `POST /api/songs` (`createSong`) creates a catalog song (201, `{ song }`).
- **Gap 1:** there is NO endpoint that returns a setlist + its ordered songs by setlist id. `setlist_songs` are only ever returned as a side effect of add/remove/reorder. The builder needs an initial read → add `GET /api/setlists/:id` (below).
- **Gap 2:** `setlist_songs.notes` is returned in responses but NO endpoint accepts writing it. `reorderSetlistSchema` and `addSetlistSongSchema` have no `notes`. The AC requires an editable per-song notes field → extend the PUT reorder path to persist notes (below).
- `SetlistSongResponse` (from `app/api/setlists/[id]/handler.ts`) has NO `title`/`artist` — only `songId`, `position`, `keyOverride`, `defaultKey`, `effectiveKey`, `isOverridden`, `notes`. The builder must map title/artist by `songId` from the `/api/songs` catalog it already loads. Do NOT change `toSetlistSongResponse` / `SetlistSongResponse` shape — existing tests assert both directly.
- Response envelope: success `{ data: ... }`, error `{ error, code }` (`lib/api/response.ts`). Client reads `body.data.*`.
- No drag-and-drop library is installed. Use **native HTML5 DnD** (`draggable`, `onDragStart`/`onDragOver`/`onDrop`). Do NOT add any dependency.
- UI kit: `components/ui/Button.tsx` (`variant="primary"|"secondary"`), `components/ui/Badge.tsx` (`tone`), `components/ui/Modal.tsx` (`{ open, onClose, children }`).
- Valid key list lives in `schemas/songs.ts` as the ordered `ASCII_SONG_KEYS` (17 keys) — currently NOT exported.

## Backend changes

### 1. Add `GET /api/setlists/:id` → returns setlist + ordered songs

`app/api/setlists/[id]/handler.ts` — add exported `getSetlistWithSongs(req, id, lookup?)`:
- `requireAuth`; `requireRole(ctx, ["admin", "set_leader"])` (this is the Set Leader editing surface).
- Get supabase JWT client (same `auth()`/`getToken({ template: "supabase" })` pattern as siblings).
- Load setlist tenant-scoped: `.from("setlists").select("*").eq("id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`. Missing → `fail("Setlist not found", ErrorCode.NOT_FOUND, 404)`. DB error → 500.
- Reuse the existing private `loadSongResponses(supabase, id)` helper for the ordered songs; on error → 500.
- Return `ok({ setlist: toSetlistResponse(data), songs })`. (Return for both draft and published — the client needs status to render the locked state.)
- Wrap in the same `try/catch` mapping `ApiException` → `fail(err.message, err.code, err.status)`, else 500.

`app/api/setlists/[id]/route.ts` — add:
```ts
export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getSetlistWithSongs(req, id);
}
```
Keep the existing `PUT` export unchanged.

### 2. Persist per-song `notes` through the PUT reorder path

`schemas/setlists.ts` — extend `reorderSetlistSchema`'s per-song object with an optional notes field:
```ts
notes: z.string().trim().max(1000).nullish(),
```
(Leave `addSetlistSongSchema` unchanged — notes are added via PUT after a song is in the setlist.)

`app/api/setlists/[id]/handler.ts`, inside `reorderSetlist`'s per-song update loop — only touch `notes` when the client actually sent it, so existing reorder callers (that omit notes) do NOT wipe notes:
```ts
const update: Record<string, unknown> = {
  position: i + 1,
  key_override: entry.keyOverride ?? null,
};
if (entry.notes !== undefined) update.notes = entry.notes ?? null;
// ...supabase.from("setlist_songs").update(update as unknown as ...Update)
```
`entry.notes === undefined` (field absent) → leave the column as-is; `null` → clear it; string → set it. Do not change any other reorder behavior (membership check, position rewrite, response).

### 3. Export the ordered key list for the dropdown

`schemas/songs.ts` — add `export const SONG_KEY_OPTIONS = ASCII_SONG_KEYS;` (the ordered 17-key ASCII array). Do NOT change `VALID_SONG_KEYS` / `isValidSongKey`.

## Frontend

### `app/(app)/setlists/[id]/page.tsx` (replace the stub)

Server wrapper mirroring `app/(app)/week/[id]/page.tsx`:
```tsx
import SetlistBuilder from "./setlist-builder";
export default async function SetlistBuilderPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SetlistBuilder setlistId={id} />;
}
```

### `app/(app)/setlists/[id]/setlist-builder.tsx` (new, `"use client"`)

Follow `app/(app)/week/[id]/week-view.tsx` for structure: local minimal types, `ViewState` union, `useEffect` load with a `cancelled` guard, view-state early returns, CSS module.

Signature: `export default function SetlistBuilder({ setlistId }: { setlistId: string })`.

Local types (subset of the envelopes above):
```ts
type CatalogSong = { id: string; title: string; artist: string | null; defaultKey: string | null };
type SetlistSong = { songId: string; position: number; keyOverride: string | null; defaultKey: string | null; effectiveKey: string | null; notes: string | null };
type SetlistMeta = { id: string; status: "draft" | "published" };
type ViewState = "loading" | "ready" | "forbidden" | "not-found" | "error";
```

**Initial load** (`Promise.all`):
- `GET /api/setlists/${setlistId}` → 403 → `forbidden`; 404 → `not-found`; other non-ok → `error`. On ok, set `songs = body.data.songs`, `meta = { id, status } = body.data.setlist`.
- `GET /api/songs` → catalog for title/artist lookup + search. If it 403s treat as forbidden; other failure → degrade search to empty (non-critical), still render.
- Build `catalogById: Map<songId, CatalogSong>` so the right panel can resolve title/artist (and defaultKey) per setlist song.

**Left panel — search + quick-add:**
- Text input filtering the catalog client-side (case-insensitive substring on title OR artist). (Server `?q=` is available but client-side filter over the already-loaded catalog is sufficient and simpler.)
- Each result row: title, artist, defaultKey, and an "Add" button (disabled if the song's `id` is already in `songs`). Add → `POST /api/setlists/${setlistId}/songs` `{ songId }`; on 409 show inline "That song is already in the setlist."; on ok replace `songs` from `body.data.songs`.
- Quick-add form shown when the search term is non-empty and no catalog row matches: title (prefilled with the search term, required), artist (optional), key `<select>` from `SONG_KEY_OPTIONS` plus a blank "— none —" option (optional). Submit → `POST /api/songs` `{ title, artist?, default_key? }`; on ok, add the returned `body.data.song` to the local catalog AND immediately `POST .../songs { songId }` to put it in the setlist, then refresh `songs` from that response. Surface a validation/failure message inline.

**Right panel — the setlist (ordered):**
- Empty state when `songs.length === 0`.
- Each row (ordered by `position`): position number, title + artist (from `catalogById`), a key `<select>` (options = `SONG_KEY_OPTIONS`, plus a blank option meaning "no key"/null), a notes text input, a drag handle, and a Remove button.
  - **Key select** value = `effectiveKey ?? ""`. On change: compute the song's `defaultKey`; if the chosen value equals `defaultKey` (or both empty) send `keyOverride: null` (using default), otherwise send the chosen key. Persist via the reorder PUT (below) with the updated per-song `keyOverride`.
  - **Notes input** — persist on blur (not per keystroke) via the reorder PUT, sending that song's `notes`.
  - **Remove** → `DELETE /api/setlists/${setlistId}/songs/${songId}`; on ok replace `songs` from `body.data.songs`.
- **Drag reorder** (native HTML5): dragging a row and dropping onto another reorders the local array, then persist via the reorder PUT.

**Persistence via PUT (single mechanism for reorder + key + notes):**
`PUT /api/setlists/${setlistId}` body `{ songs: [{ songId, keyOverride, notes }, ...] }` in the desired display order — always send the **full current** song set (the endpoint requires exact membership match and derives position from array index). On ok, replace local `songs` from `body.data.songs` (authoritative positions/keys/notes). On non-ok show a non-blocking inline error and reload from `GET /api/setlists/:id` to resync.

**Bottom bar:**
- Song count (e.g. `songs.length === 1 ? "1 song" : \`${songs.length} songs\``).
- **Publish** button — NOT disabled at zero songs (BR-01). Clicking opens a confirmation step (use `components/ui/Modal.tsx`): confirm copy that, when `songs.length === 0`, explicitly notes the setlist will be published with no songs yet. Confirm → `POST /api/setlists/${setlistId}/publish`; on ok set `meta.status = "published"` and render the locked state; on 409 show "Setlist is already published."; other failure → inline error.

**Published (locked) state:** when `meta.status === "published"`, disable all editing controls (add / key / notes / drag / remove / publish) and show a banner with an **Unlock to edit** button → `POST /api/setlists/${setlistId}/unlock`; on ok set `meta.status = "draft"` and re-enable editing. (All the editing endpoints already 409 on a published setlist; this just makes the UI coherent instead of letting the user hit dead 409s.)

**View-state renders** (copy the loading/forbidden/not-found/error blocks from `week-view.tsx`):
- `forbidden`: "This screen is available to Set Leaders and Admins only."
- `not-found`: "Setlist not found".
- `error`: generic "Something went wrong".

### `app/(app)/setlists/[id]/setlist-builder.module.css` (new)

Desktop-first two-column layout (left search panel / right setlist), a sticky/fixed bottom bar, and row styling. Copy variable usage + container conventions from `app/(app)/week/[id]/week-view.module.css` (`.container` max-width, `var(--color-*)`). No global style changes.

## Edge cases the implementation must handle

- **Zero songs:** right panel empty state; Publish still enabled; confirmation still shown with the "no songs yet" wording.
- **Search no match:** show the quick-add form (title required; artist + key optional).
- **Duplicate add:** POST songs → 409 → inline "already in the setlist"; do not mutate local state.
- **Published setlist on load:** render locked/read-only with an Unlock affordance; editing controls disabled.
- **Key = default:** selecting the option equal to the song's `defaultKey` clears the override (send `keyOverride: null`). Song with `defaultKey === null`: blank option = null.
- **Notes:** empty notes → `null`; persist on blur only; never wipe another song's notes (PUT always sends every song's current notes).
- **Reorder to same slot / no-op drag:** harmless; safe to skip the PUT or send it — either is fine.
- **403 / 404 / 500** on initial load → `forbidden` / `not-found` / `error` views. Mutation failures → non-blocking inline error, and on PUT failure resync from GET.
- **Backend:** `getSetlistWithSongs` must be tenant-scoped (404 for other-tenant/missing, never leak existence via 403). PUT reorder must NOT wipe `notes` when the client omits the field (`entry.notes === undefined` → leave column unchanged).

## Explicitly out of scope

- Spotify autocomplete / metadata enrichment (issue: nice-to-have, Phase-1 optional).
- Wiring the "Edit setlist" button in `app/(app)/week/[id]/week-view.tsx` (it has a `TODO(#64)`) — the builder is reachable directly by setlist id; entry-point wiring is not in this issue's AC. Leave the TODO as-is.
- Any change to `toSetlistSongResponse` / `SetlistSongResponse` shape, or to `addSetlistSongSchema`.

## Verify before finishing

`bun run lint`, `bun run typecheck`, `bun run test` (Jest). Existing setlist route tests
(`tests/unit/app/api/setlists-songs-route.test.ts`, `setlists-key-override.test.ts`,
`setlists-publish-route.test.ts`) must still pass — the notes change is additive/guarded and
`toSetlistSongResponse` is untouched.
