# Changes — Issue #53: Song catalog CRUD + search (BR-09 key validation)

## Summary

Implemented `GET /api/songs` (list/search) and `POST /api/songs` (create),
per `.pipeline/spec.md`. API layer only — no migrations touched, no
Spotify/familiarity/override/update/delete work (explicitly out of scope).

## Files changed

- `schemas/songs.ts` (replaced placeholder)
  - `VALID_SONG_KEYS: ReadonlySet<string>` — 17 ASCII + 10 Unicode chromatic
    key spellings (BR-09), case-sensitive exact match.
  - `isValidSongKey(key)` helper.
  - `createSongSchema` — shape-only Zod validation for POST body (`title`
    required, `artist`/`default_key`/`bpm`/`tags` optional). Deliberately
    does NOT check key membership — that's a handler-level 422, not a Zod
    400 (see BR-09 edge case below).
  - `songSearchQuerySchema` — `{ q?: string }` for GET query params.

- `app/api/songs/handler.ts` (new)
  - `SongResponse` type + private `toSongResponse` mapper (snake_case row →
    camelCase response, `tags: row.tags ?? []`).
  - `listSongs(req, lookup?)`: `requireAuth` → `requireRole(["admin",
    "set_leader", "member"])` → parse `q` via `songSearchQuerySchema` → JWT
    guard → `songs` query scoped by `church_group_id`, optional
    `.or("title.ilike.%q%,artist.ilike.%q%")` when `q` is non-empty,
    `.order("title")` → `ok({ songs: [...] })`.
  - `createSong(req, lookup?)`: `requireAuth` → `requireRole(["admin",
    "set_leader"])` → `req.json()` + `createSongSchema.safeParse` (400 on
    failure) → **BR-09 check**: if `default_key` present and
    `!isValidSongKey(...)` → `fail(..., VALIDATION_FAILED, 422)` — this is
    the load-bearing behavior for this issue, malformed body is 400,
    semantically-invalid key value is 422 → JWT guard → insert (narrow
    `as unknown as Database[...]["Insert"]` cast, same rationale as
    `instruments/handler.ts`) → `ok({ song: ... }, 201)`.
  - Copies the auth/JWT/try-catch shape of `app/api/instruments/handler.ts`
    exactly; no duplicate-title guard (spec explicitly says catalog allows
    same-titled songs — do not add the instruments-style 409 check).

- `app/api/songs/route.ts` (rewritten) — replaced `notImplemented` stubs
  with `GET`/`POST` wired to `listSongs`/`createSong`, mirroring
  `app/api/instruments/route.ts`.

- `lib/supabase/types.ts` — added `SongsRow` type and registered
  `Tables.songs` (Row/Insert/Update/Relationships), following the
  `instruments` entry's pattern. `Insert` narrows the same way as other
  tables with DB-default columns (`created_at` has a `now()` default but the
  hand-rolled type still needs it optional).

- `tests/unit/app/api/songs-route.test.ts` (new) — 28 tests, follows the
  `instruments-route.test.ts` mock harness (`jest.mock` for `@clerk/nextjs/server`
  and `@/lib/supabase/client`, `makeLookup`/`setUpAuth`/`makeChain`/
  `makeSupabaseClient`) plus the audit-log test's `nextUrl.searchParams`
  `makeReq` pattern for GET query params. `makeChain` stubs `.eq`, `.or`,
  `.order`, `.select`, `.single`.
  - GET: all songs / ordered, search filter applied (`.or` called with the
    exact ilike string), empty `q` → no filter, empty catalog, tags-null →
    `[]`, 403 for `guest`, 401 no-JWT, 500 on DB error.
  - POST: minimal valid body, ASCII keys (`C#`, `Bb`), Unicode key (`D♭`),
    invalid keys (`H`, `c#`, `Cmaj`, `Z`, `bb`) → **422** VALIDATION_FAILED
    (the BR-09 AC), missing/empty/whitespace title → 400, title/artist
    length bounds, `bpm` bounds (non-integer/≤0/>400) and omission, `tags`
    non-array / non-string elements and empty-array acceptance,
    missing/malformed JSON body → 400, role gating (`member`/`guest` → 403,
    `admin`/`set_leader` → allowed), 401 no-JWT, 500 on insert error.

- `.pipeline/spec.md` — retained as written by the Planning stage this run
  for Issue #53 (previously contained the #52 spec from the prior pipeline
  run; each run overwrites this file per the AGENTS.md contract).

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` (Jest) — full suite: 50 suites / 569 tests passed, including
  the new 28-test `songs-route.test.ts`.

## Follow-up (review #53 nullish)

- Optional create fields (`artist` / `default_key` / `bpm` / `tags`) now use
  Zod `.nullish()` so explicit JSON `null` is accepted as omitted → **201**.
- BR-09 membership check uses `parsed.default_key != null`, so null skips key
  validation. Closes the reviewer’s blocking item (`.optional()` rejected
  null → 400 vs spec edge case omit/null → 201).

## Notes for the Tester

- The BR-09 422-vs-400 split is the crux of this issue: confirm a malformed
  body (e.g. missing `title`) is 400, while a syntactically fine but
  semantically invalid `default_key` (e.g. `"H"`, `"c#"`) is 422.
- Case sensitivity matters: `Bb` valid, `bb`/`BB` invalid.
- Confirm `q=""` (present but empty) returns the unfiltered list (no `.or`
  call), distinct from `q` entirely absent.
- Confirm role gating is enforced *before* any DB call (test harness asserts
  `mockGetSupabaseClient` not called for 403 cases).
- No migration changes were made or needed — `songs` table, RLS policies,
  and `default_key varchar(5)` column already exist per the spec.
