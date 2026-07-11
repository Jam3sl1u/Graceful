# Changes — Issue #34: Implement availability set/get

## Open question — resolution applied

The spec's one open question ("how are weekly/monthly blocks expressed in the
`PUT` body?") was resolved by a human decision: **option (b)** — the `PUT`
body accepts either a single `date` or an inclusive `startDate`..`endDate`
range per entry, expanded server-side into per-date upserts. This is what's
implemented below (the `setAvailabilityEntrySchema` range branch and the
expansion loop in the handler were kept, not dropped).

## Files changed

### `lib/supabase/types.ts` (modified)
Added `AvailabilityRow` (mirrors the DB `availability` table:
`id, user_id, church_group_id, date, is_available, note, created_at`) and
registered it under `Database.public.Tables.availability`, following the same
`Insert` treatment as `member_profiles`/`service_weeks` (DB-defaulted columns
`id`, `created_at`, `is_available` made optional on `Insert`).

### `schemas/availability.ts` (replaced placeholder)
- `DATE_RE` — `YYYY-MM-DD` regex.
- `isValidDateString` (private helper) — round-trips a date string through
  UTC `Date` construction/`toISOString()` to reject non-existent calendar
  dates like `2026-02-30` while accepting real ones.
- `getAvailabilityQuerySchema` — `{ user_id?: uuid }` for `GET`.
- `setAvailabilityEntrySchema` — one `PUT` entry: `date?`, `startDate?`,
  `endDate?`, `isAvailable?: boolean`, `note` (trimmed/capped-500/nullish,
  empty → `null`, same pattern as `schemas/profile.ts`'s bio). A
  `superRefine` enforces: exactly one of "`date` alone" or "`startDate` AND
  `endDate` together" is present (both forms together, or neither, is
  rejected); every present date string must be a real calendar date; for a
  range, `startDate <= endDate`.
- `setAvailabilitySchema` — `{ entries: [...].min(1).max(400) }` for the `PUT`
  body.

### `app/api/availability/handler.ts` (new)
- `AvailabilityEntry` response type: `{ userId, date, isAvailable, note }`.
- `getAvailability(req, lookup?)` — `requireAuth` → parse `?user_id=` query
  → if `user_id` is present and differs from the caller,
  `requireRole(ctx, ["admin", "set_leader"])` (else 403 `FORBIDDEN`), else
  target is the caller's own id → JWT/`getSupabaseClient` → `select("user_id,
  date, is_available, note").eq("user_id", targetUserId).order("date")` →
  maps rows → `ok({ availability })`. No `church_group_id` filter (RLS already
  scopes it); returns only stored rows, does not synthesize "available"
  defaults for unset dates.
- `expandEntryDates(entry)` (private helper) — single-date entry → `[date]`;
  range entry → every date from `startDate` to `endDate` inclusive
  (UTC-day-stepped to avoid DST issues).
- `setAvailability(req, lookup?)` — `requireAuth` (caller's own availability
  only, no role gate) → parse body with `setAvailabilitySchema` → expand every
  entry into concrete dates, enforcing a running total cap of **366** expanded
  dates (400 `VALIDATION_FAILED` if exceeded) → dedupe into a `Map<date, {
  isAvailable, note }>`, **last-entry-wins**, since a single upsert can't hit
  the same `(user_id, date)` conflict target twice → JWT/`getSupabaseClient`
  → build one row per resolved date (`isAvailable` defaults to `true` when
  omitted) with the same narrow `as unknown as
  Database[...]["availability"]["Insert"][]` cast the profile handler uses
  for the DB-defaulted-column mismatch → `upsert(rows, { onConflict:
  "user_id,date" }).select(...)` → maps rows → `ok({ availability })`.
- Both handlers wrap everything in the same try/catch pattern as
  `app/api/profile/handler.ts`: `ApiException` → `fail(err.message, err.code,
  err.status)`, anything else → 500 `INTERNAL`.

### `app/api/availability/route.ts` (modified)
Replaced the two `notImplemented` stubs with thin `GET`/`PUT` delegators to
`getAvailability`/`setAvailability`, matching `app/api/profile/route.ts`.

## Explicitly not touched (per spec's out-of-scope list)
- `app/api/availability/[date]/route.ts` (DELETE, #35) — left as a stub.
- `app/api/availability/team/route.ts` (GET, #36) — left as a stub.
- Conflict detection on availability change (#46).
- Leaders/admins setting *another* member's availability via `PUT` — GET-only
  cross-member access, gated to admin/set_leader.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — full existing suite passes (206 tests, 16 suites); no
  regressions. No dedicated `availability-route.test.ts` was added — per the
  pipeline split, unit tests for this handler are the tester stage's job (see
  spec's "Tests" section for what to mirror from
  `tests/unit/app/api/profile-route.test.ts`). I additionally hand-verified
  `schemas/availability.ts`'s edge cases (valid single date, invalid calendar
  date, valid/reversed range, date+range together, neither present,
  range-with-only-one-field, empty `entries`, whitespace `note` → `null`)
  with a throwaway test file that was run and then deleted — it is not part
  of this commit.

## What the Tester should focus on
- The `setAvailabilityEntrySchema` `superRefine` branches (see edge-case list
  in the spec) — especially "date + range together", "neither form", and
  "only one of startDate/endDate".
- `expandEntryDates` for a range spanning a month boundary and the 366-date
  cap (both under and over, and exactly at the boundary via total across
  multiple entries).
- Dedup/last-entry-wins when two entries in the same `PUT` body resolve to the
  same date (e.g. an explicit `date` inside an overlapping range from an
  earlier entry).
- Auth matrix for `GET`: own-id (any role) vs. other-id (member → 403,
  set_leader/admin → 200), malformed `user_id` → 400.
- `isAvailable` omitted → stored/returned as `true`; `note` empty/whitespace
  → `null`.
- 401 paths (no Clerk `userId`, missing Supabase JWT) mirroring
  `profile-route.test.ts`'s structure.
