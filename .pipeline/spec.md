# Spec — Issue #57: Per-song key override validation & default-vs-override distinction (BR-09)

## OPEN QUESTIONS

None blocking. See "Design decision" below for the one interpretation call made — it is
the only reading consistent with all four acceptance criteria plus the code/tests already
in the repo, so the pipeline should proceed.

## Summary of current state (already verified in the repo)

Most of this issue is already implemented by #55. Do not re-plumb storage or re-add
validation. The state today:

- `setlist_songs.key_override varchar(5)` exists (migration
  `supabase/migrations/20260702000003_cluster_3_scheduling_core.sql`), nullable, no
  server default. The FK `setlist_songs.song_id -> songs(id)` exists
  (`20260714000001_setlist_songs_song_id_fkey.sql`).
- BR-09 validation on `keyOverride` is **already done** in
  `app/api/setlists/[id]/handler.ts` for both `addSetlistSong` (POST) and
  `reorderSetlist` (PUT): a shape-valid but non-musical key returns `422`
  (`isValidSongKey` from `schemas/songs.ts`, checked in the handler not in Zod, so a
  malformed body is `400` and a bad key value is `422`). **AC #2 is satisfied — no code
  change needed. Tester must still cover it independently.**
- Overriding never touches `songs.default_key`: the handlers only ever `update`/`insert`
  the `setlist_songs` table. **AC #3 is satisfied — no code change needed.**

**The only missing piece is AC #4**: the setlist-song response currently exposes only
`keyOverride` (`toSetlistSongResponse` in `app/api/setlists/[id]/handler.ts`, lines
14-32) and gives the client no way to see the song's `default_key`, the effective key to
play, or whether this week's value is a real override vs. the catalog default.

## Design decision (AC #1 interpretation)

"`key_override` defaults to the song's `default_key` but is independently editable"
means **the resolved/effective key defaults to `default_key`**, not that we copy
`default_key` into the `key_override` column on insert. `key_override` stays `NULL` to
mean "using the song's default"; a non-null value means "overridden this week". This is
the only interpretation that also lets AC #4 distinguish default vs. override, matches
the existing schema comment ("keyOverride null clears any override") and the existing
test ("omitted -> clears existing override" stores `null`). **Do NOT change insert/update
logic to copy `default_key` into `key_override`.**

## Files to modify

### 1. `app/api/setlists/[id]/handler.ts` (primary change)

**a. Extend the response type** `SetlistSongResponse` (currently lines 14-21) with three
derived fields:

```ts
export type SetlistSongResponse = {
  id: string;
  setlistId: string;
  songId: string;
  position: number;
  keyOverride: string | null;   // null = using the song's default key
  defaultKey: string | null;    // the song's catalog default_key (songs.default_key)
  effectiveKey: string | null;  // keyOverride ?? defaultKey — the key to actually play
  isOverridden: boolean;        // keyOverride != null
  notes: string | null;
};
```

**b. Change `toSetlistSongResponse`** to take the song's default key as a second arg and
compute the derived fields:

```ts
export function toSetlistSongResponse(
  row: SetlistSongsRow,
  defaultKey: string | null,
): SetlistSongResponse {
  return {
    id: row.id,
    setlistId: row.setlist_id,
    songId: row.song_id,
    position: row.position,
    keyOverride: row.key_override,
    defaultKey,
    effectiveKey: row.key_override ?? defaultKey,
    isOverridden: row.key_override != null,
    notes: row.notes,
  };
}
```

**c. Resolve default keys before mapping.** All three handlers currently end with
`loadOrderedSongs(...)` then `(rows ?? []).map(toSetlistSongResponse)` (lines 166-171,
274-279, 353-358). Introduce one helper and route all three through it, replacing that
tail:

```ts
// Loads the setlist's songs (ordered by position) and joins each row to its
// song's default_key so the response can distinguish "using default" from
// "overridden this week". Returns fully-formed response objects.
async function loadSongResponses(
  supabase: SupabaseClient<Database>,
  setlistId: string,
): Promise<{ data: SetlistSongResponse[] | null; error: unknown }> {
  const { data: rows, error } = await loadOrderedSongs(supabase, setlistId);
  if (error) return { data: null, error };

  const songRows = rows ?? [];
  const songIds = [...new Set(songRows.map((r) => r.song_id))];

  const defaultKeyById = new Map<string, string | null>();
  if (songIds.length > 0) {
    const { data: songs, error: songsError } = await supabase
      .from("songs")
      .select("id, default_key")
      .in("id", songIds);
    if (songsError) return { data: null, error: songsError };
    for (const s of songs ?? []) {
      defaultKeyById.set(s.id, s.default_key ?? null);
    }
  }

  return {
    data: songRows.map((r) => toSetlistSongResponse(r, defaultKeyById.get(r.song_id) ?? null)),
    error: null,
  };
}
```

Then in each of `reorderSetlist`, `addSetlistSong`, `removeSetlistSong`, replace the
final `loadOrderedSongs` + `.map(...)` block with:

```ts
const { data: songs, error } = await loadSongResponses(supabase, id);
if (error) {
  return fail("Internal error", ErrorCode.INTERNAL, 500);
}
return ok({ songs }, /* keep existing status: 201 for addSetlistSong, default 200 elsewhere */);
```

Notes:
- Keep `loadOrderedSongs` as-is (still used inside `loadSongResponses`).
- Tenant scoping on the `songs` lookup is handled by RLS (the caller already holds a
  supabase client built from their JWT, and the song_ids come from a tenant-scoped
  setlist). Do not add an extra `church_group_id` filter — the helper has no `ctx`.
- `.in(...)` is standard PostgREST; `songs.default_key` and `songs.id` exist on the
  `songs` Row type in `lib/supabase/types.ts`.

### 2. `tests/unit/app/api/setlists-songs-route.test.ts` (keep existing suite green)

The response shape change breaks the current `expect(...).toEqual([...])` / `toMatchObject`
assertions. The Coder must update this existing suite so it stays green (this is
maintenance of existing tests, not new coverage — new coverage is the Tester's job):

- Add a `default_key` field to the `SongsRow` fake type (line ~64-65) and to each song in
  `baseState().songs` (lines 235-240). Give them distinct values so `defaultKey` /
  `effectiveKey` are meaningfully assertable, e.g. song-1 `"C"`, song-2 `"D"`,
  song-3 `"E"`, song-4 (other tenant) any value.
- Extend the fake `makeSelectChain` to support `.in(field, values)` (push a predicate
  that matches when `values.includes(row[field])`), since `loadSongResponses` calls
  `.from("songs").select("id, default_key").in("id", songIds)`. Follow the existing
  `eq`/`order` chain-method pattern in that file.
- Update the three expected-response objects (reorder happy path lines 295-320, remove
  happy path lines 671-674, add happy path `toMatchObject` line 525) to include the new
  `defaultKey`, `effectiveKey`, `isOverridden` fields. Concretely, for a row with
  `key_override` non-null: `isOverridden: true`, `effectiveKey` = the override; for a row
  with `key_override: null`: `isOverridden: false`, `effectiveKey` = that song's
  `default_key`, `keyOverride: null`.

## Edge cases the implementation must handle

1. **Empty setlist** (removeSetlistSong removes the last song): `songIds` is empty, skip
   the `songs` query, return `{ songs: [] }`. (Existing test "returns { songs: [] } after
   removing the last remaining song" must still pass.)
2. **`key_override` null (using default)**: `effectiveKey` = `defaultKey`,
   `isOverridden` = `false`.
3. **`key_override` set to a value that happens to equal `default_key`**: still
   `isOverridden` = `true` (the leader explicitly set it this week). Derive `isOverridden`
   from `key_override != null`, NOT from comparing against `default_key`.
4. **Song has `default_key` = null** (catalog default unset) and no override: `defaultKey`
   = `null`, `effectiveKey` = `null`, `isOverridden` = `false`.
5. **Song row missing / default_key not found in the map**: default to `null` (already
   handled by `defaultKeyById.get(...) ?? null`).
6. **BR-09 (AC #2) unchanged**: invalid `keyOverride` -> `422` before any DB mutation;
   malformed body -> `400`. Do not move these checks.

## Out of scope (do NOT implement)

- Actual transposition (Phase 3).
- Copying `default_key` into `key_override` on insert (see Design decision).
- A new read-only "list setlist songs" GET endpoint. There is currently no endpoint that
  returns setlist songs on GET — `GET /api/service-weeks/:id/setlist`
  (`app/api/service-weeks/[id]/setlist/handler.ts`) returns only setlist metadata, and the
  three mutating handlers return the `{ songs }` array. Enhancing `SetlistSongResponse`
  covers every place songs are returned, which satisfies AC #4. Adding a new GET endpoint
  is not requested by this issue — do not add one.
- Any change to `schemas/setlists.ts` or `schemas/songs.ts`. The Zod schemas and the
  `varchar(5)` `keyOverride` shape are already correct.

## Verification (Coder)

Run `bun run lint`, `bun run typecheck`, and
`bun run test tests/unit/app/api/setlists-songs-route.test.ts` (all green) before
finishing.

## Pattern references

- Manual join via a fetched map (repo has no PostgREST embeds in handlers — confirmed):
  follow the explicit second-query style used across `app/api/**/handler.ts`.
- `default_key` -> `defaultKey` camelCase mapping and `default_key`/`id` select columns:
  `app/api/songs/handler.ts` (lines 25, 35, 68, 133).
- BR-09 handler-level key check (leave untouched): `app/api/setlists/[id]/handler.ts`
  lines 104-109 (reorder) and 196-200 (add), using `isValidSongKey` from `schemas/songs.ts`.
