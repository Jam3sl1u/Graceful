# Changes — Issue #54: Draft setlist creation (BR-01 zero-song valid state)

## Summary

Implemented `GET` and `POST /api/service-weeks/:id/setlist`, replacing the two
`notImplemented` (501) stubs. No migration and no change to `createServiceWeek`
were needed — the `setlists` table, RLS policies, and week-creation
auto-create path already existed and were left untouched, per the spec.

## Files changed

- **`app/api/service-weeks/[id]/setlist/handler.ts`** (new). Mirrors the
  structure of `app/api/service-weeks/[id]/handler.ts`.
  - `toSetlistResponse` / `SetlistResponse` — maps a `setlists` row to camelCase
    API shape (no songs array — out of scope, tracked separately as #55).
  - `getSetlist(req, id, lookup?)` — any authenticated role. Queries
    `setlists` scoped by `service_week_id` + `church_group_id`. RLS hides
    drafts from members/guests, so both "no setlist" and "draft hidden by
    RLS" map to a single 404 (never 403, never leaks existence). Guests
    additionally require a matching invitation for the week (mirrors
    `getServiceWeek`) — no invitation -> 404, not 403.
  - `createSetlist(req, id, lookup?)` — `admin`/`set_leader` only
    (`requireRole` throws 403 for member/guest before Supabase is even
    constructed). Flow: tenant-scoped `service_weeks` existence check (404 if
    missing/cross-tenant) -> get-or-create on `setlists` (200 + existing row
    if one exists — leader/admin RLS sees drafts too; 201 + newly inserted
    draft row otherwise). Insert payload only sets `church_group_id`,
    `service_week_id`, `created_by`; `status` is left to the DB default
    (`'draft'`). No request body is read or validated — zero songs is a valid
    setlist state (BR-01).
  - All error paths: Supabase `error` -> 500 `ErrorCode.INTERNAL`; caught
    `ApiException` -> mapped to its own status/code; anything else -> 500.

- **`app/api/service-weeks/[id]/setlist/route.ts`** (rewritten). Replaced the
  `notImplemented` stubs with thin `GET`/`POST` handlers following the `Ctx`
  params pattern from `app/api/service-weeks/[id]/route.ts`, delegating to
  `getSetlist`/`createSetlist`.

- **`tests/unit/app/api/service-weeks-setlist-route.test.ts`** (new). Mirrors
  the mocking harness from `tests/unit/app/api/service-weeks-id-route.test.ts`
  (`jest.mock` of `@clerk/nextjs/server` and `@/lib/supabase/client`,
  chainable `makeChain`/`makeSupabaseClient`/`makeLookup`/`setUpAuth`
  helpers). Extended `makeChain`/`makeSupabaseClient` to support
  `.insert(...).select(...).maybeSingle()` alongside the existing
  `.select().eq().eq().maybeSingle()` chain, with an `onInsert` hook to
  capture the insert payload for assertions. 16 test cases covering:
  - `getSetlist`: 401 (no Clerk userId, lookup never consulted), 401 (no
    JWT), 200 for a member seeing a published setlist, 404 when the setlist
    query returns `{ data: null }` (draft-hidden-by-RLS / no-setlist case),
    200 for a guest with a matching invitation, 404 (not 403) for a guest
    without one, 500 on query error.
  - `createSetlist`: 401 cases, 403 for member and guest (asserting Supabase
    is never constructed), 404 when the tenant-scoped week lookup returns
    null, 500 on week-lookup error, 200 + no insert when a setlist already
    exists, 201 + captured insert payload (`church_group_id`,
    `service_week_id`, `created_by`) when creating a fresh draft, 500 on
    insert error.

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test tests/unit/app/api/service-weeks-setlist-route.test.ts` — 16/16
  passed.
- `bun run test` (full suite) — 52 suites / 596 tests, all passed (no
  regressions).

## Notes for the Tester

- Confirm the 404-not-403 behavior for members/guests hitting a draft setlist
  is actually indistinguishable from a genuinely absent setlist (no status
  leak).
- Confirm the get-or-create idempotency on `POST`: calling it twice for the
  same week never produces a second insert / a 409, and the second call
  returns 200 (not 201) with the same row.
- Confirm the tenant-scoped week check on `POST` blocks cross-tenant /
  nonexistent week ids with 404 before any insert is attempted.
- Confirm zero-song / no-body semantics: `POST` does not read or require
  `req.json()`.
- No migration changes were made or needed — the `setlists` table, its RLS
  policies, and the auto-create-on-week-creation path already existed per the
  spec.
