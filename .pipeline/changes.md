# Changes — Issue #37: Service Week CRUD

## Open questions resolved per spec.md

1. **Chat room placeholder stays deferred**, per spec.md's OPEN QUESTION 1: there is
   no `chat_rooms` table (`20260702000005_cluster_5_partial.sql` explicitly defers all
   of chat to Phase 2), so `POST /api/service-weeks` auto-creates the draft setlist
   only. The chat room placeholder is left for a follow-up issue with its own migration.
2. **All five create fields are required** (already matched spec.md's stated
   decision — no change needed here beyond implementing it).

## Files changed

### `lib/supabase/types.ts` (modified)
- Added three hand-written table types to `Database["public"]["Tables"]`:
  `service_weeks`, `setlists`, `invitations` (per spec.md §2). Each follows the
  existing `Row`/`Insert`/`Update`/`Relationships: []` shape; `Insert` omits
  DB-defaulted columns (`id`, `created_at`, `is_cancelled` / `status`+`published_at`+
  `notes`) as optional. Imports `SetlistStatus`/`InvitationStatus` from `@/types/domain`.

### `schemas/service-weeks.ts` (rewritten)
- Replaced the empty placeholder with `createServiceWeekSchema` (all five fields —
  `serviceDate`, `title`, `sermonTopic`, `sermonScripture`, `speakerName` —
  required, non-empty after trim, per the issue AC) and `updateServiceWeekSchema`
  (all fields optional, `.refine` requires at least one key present).

### `app/api/service-weeks/handler.ts` (new)
- `toServiceWeekResponse` (exported, reused by `[id]/handler.ts`) maps the DB row
  (snake_case) to the camelCase `ServiceWeekResponse` shape.
- `listServiceWeeks` — any authenticated member; guests are scoped to weeks they
  have an `invitations` row for (queries `invitations.user_id`, collects
  `service_week_id`s, then `.in("id", ids)` on `service_weeks`; zero invitations ⇒
  `{ serviceWeeks: [] }` without querying `service_weeks` at all).
- `createServiceWeek` — set_leader/admin only (`requireRole`). Validates with
  `createServiceWeekSchema`, inserts `service_weeks`, then sequentially inserts
  the draft `setlists` row (no explicit `status` — DB default `'draft'`). Either
  insert failing → 500 `INTERNAL`; an orphaned week on setlist-insert failure is
  an accepted edge case (no transaction/RPC in scope), matching spec.md's stated
  tradeoff.

### `app/api/service-weeks/route.ts` (rewritten)
- Thin `GET`/`POST` delegators to the new handler, replacing the `notImplemented`
  stubs.

### `app/api/service-weeks/[id]/handler.ts` (new)
- `getServiceWeek` — any authenticated member; 404 (not 403) for a guest with no
  matching invitation, so existence isn't leaked. 404 for wrong-tenant/missing id.
- `updateServiceWeek` — set_leader/admin only. Builds a snake_case patch object
  from only the provided fields, `.update(...).eq("id", id).eq("church_group_id",
  ...)`. No matching row → 404.

### `app/api/service-weeks/[id]/route.ts` (rewritten)
- `GET`/`PUT` now delegate (Next 15 async `params`); `DELETE` untouched —
  still `notImplemented("DELETE /api/service-weeks/[id]")` (#38, out of scope).

### `tests/unit/app/api/service-weeks-route.test.ts` (new — 22 tests)
### `tests/unit/app/api/service-weeks-id-route.test.ts` (new — 16 tests)
- Copy the `profile-route.test.ts` / `instruments-route.test.ts` mock harness
  (`jest.mock` Clerk + Supabase client, `makeLookup(role)`, `setUpAuth(jwt)`, a
  thenable `makeChain(result)` supporting `.eq/.order/.in/.select/.maybeSingle`
  chains keyed per table+operation).
- Cover every edge case in spec.md's list.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — full suite passes.
- `bun run format:check` (touched files only, via `prettier --write`) — clean;
  the rest of the repo has pre-existing Prettier drift unrelated to this change,
  left untouched.
- Not run: `bun run test:rls` (integration tests against a live Supabase
  instance) — this is a code-review environment with no DB. `service_weeks`,
  `setlists`, and `invitations` (and their RLS policies) are pre-existing from
  the Cluster 3 schema (#18) and were not modified by this issue.

## What the Tester should focus on
- `createServiceWeek` does two sequential inserts (week → setlist); confirm the
  ordering and the "accepted orphan on later failure" tradeoff is acceptable.
- Guest scoping in both `listServiceWeeks` and `getServiceWeek` — 404 (not 403)
  is deliberate to avoid leaking existence to guests without an invitation.
- Out of scope, intentionally not touched: `DELETE /api/service-weeks/:id`,
  `/cancel`, `/reactivate` (#38/#39), setlist song editing/publish, event CRUD,
  invitation sending (#54/#59/#40), and chat room/message functionality (no
  `chat_rooms` table exists yet — deferred to Phase 2 per spec.md OPEN QUESTION 1;
  tracked as a follow-up issue rather than built here).
