# Changes — Issue #37: Service Week CRUD

## Human-resolved open questions applied (override spec.md's OPEN QUESTIONS section)

1. **Chat room placeholder is now built, not deferred.** Added a new, minimal
   `chat_rooms` migration and table so `POST /api/service-weeks` can auto-create an
   inactive chat-room placeholder row alongside the draft setlist, per PRD Flow 4 /
   the issue AC. Full chat functionality (messages, mentions, activation) is still
   Phase 2 — only the placeholder row exists.
2. **All five create fields are required** (already matched spec.md's stated
   decision — no change needed here beyond implementing it).

## Files changed

### `supabase/migrations/20260708000001_chat_rooms_placeholder.sql` (new)
- `chat_rooms` table: `id`, `church_group_id` (FK → `church_groups`, cascade),
  `service_week_id` (FK → `service_weeks`, cascade, **unique** — one room per week),
  `is_active boolean not null default false`, `created_by` (FK → `users`, set null),
  `created_at`. Deliberately minimal — no message/mention tables, no activation
  columns (see the migration's header comment referencing
  `20260702000005_cluster_5_partial.sql`, which still defers the rest of chat).
- RLS enabled: `chat_rooms_select_tenant` (any authenticated member of the tenant)
  and `chat_rooms_insert_leader_admin` (set_leader/admin only, matching who can
  create the service week it's attached to). No UPDATE/DELETE policy yet —
  activation is Phase 2's job.

### `lib/supabase/types.ts` (modified)
- Added four hand-written table types to `Database["public"]["Tables"]`:
  `service_weeks`, `setlists`, `invitations` (per spec.md §2), and `chat_rooms`
  (per the human override). Each follows the existing `Row`/`Insert`/`Update`/
  `Relationships: []` shape; `Insert` omits DB-defaulted columns (`id`,
  `created_at`, `is_cancelled` / `status`+`published_at`+`notes` / `is_active`)
  as optional. Imports `SetlistStatus`/`InvitationStatus` from `@/types/domain`.

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
  `createServiceWeekSchema`, inserts `service_weeks`, then **sequentially** inserts
  the draft `setlists` row (no explicit `status` — DB default `'draft'`) and the
  inactive `chat_rooms` row (no explicit `is_active` — DB default `false`). Any of
  the three inserts failing → 500 `INTERNAL`; an orphaned week/setlist on a later
  failure is an accepted edge case (no transaction/RPC in scope), matching
  spec.md's stated tradeoff for the setlist insert, now also applied to the chat
  room insert.

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

### `tests/unit/app/api/service-weeks-route.test.ts` (new — 24 tests)
### `tests/unit/app/api/service-weeks-id-route.test.ts` (new — 16 tests)
- Copy the `profile-route.test.ts` / `instruments-route.test.ts` mock harness
  (`jest.mock` Clerk + Supabase client, `makeLookup(role)`, `setUpAuth(jwt)`, a
  thenable `makeChain(result)` supporting `.eq/.order/.in/.select/.maybeSingle`
  chains keyed per table+operation).
- Cover every edge case in spec.md's list, plus two added for the human-override
  chat-room behavior: POST 201 asserts the `chat_rooms` insert payload has no
  `is_active` key (mirrors the existing `setlists` no-`status` assertion), and a
  new 500 case for a `chat_rooms` insert error after the week+setlist inserts
  succeed.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — all 13 suites / 152 tests pass (40 new for this issue).
- `bun run format:check` (touched files only, via `prettier --write`) — clean;
  the rest of the repo has pre-existing Prettier drift unrelated to this change,
  left untouched.
- Not run: `bun run test:rls` (integration tests against a live Supabase
  instance) and no `supabase db push`/migration apply — this is a code-review
  environment with no DB; the new `chat_rooms` RLS policies follow the exact
  pattern of the existing `service_weeks`/`instruments` tenant policies in
  `20260704000001_rls_policies.sql` but have not been exercised against a real
  Postgres instance.

## What the Tester should focus on
- The `chat_rooms` migration and its RLS policies are new for this issue (not
  pre-existing, unlike `service_weeks`/`setlists`/`invitations`) — worth a closer
  look since they weren't in the original spec.
- `createServiceWeek` now does three sequential inserts (week → setlist → chat
  room); confirm the ordering and the "accepted orphan on later failure" tradeoff
  is acceptable, since it now applies twice instead of once.
- Guest scoping in both `listServiceWeeks` and `getServiceWeek` — 404 (not 403)
  is deliberate to avoid leaking existence to guests without an invitation.
- Out of scope, intentionally not touched: `DELETE /api/service-weeks/:id`,
  `/cancel`, `/reactivate` (#38/#39), setlist song editing/publish, event CRUD,
  invitation sending (#54/#59/#40), and any chat message/mention functionality
  (still Phase 2 — only the inactive placeholder row exists now).
