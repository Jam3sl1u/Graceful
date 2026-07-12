# Changes — Issue #39: Service week cancel/reactivate (BR-17)

## Open questions — human resolutions applied

1. **Notification enum value.** Dedicated enum values added via migration
   (`service_week_cancelled`, `service_week_reactivated`), NOT a reuse of
   `scheduling_conflict`.
2. **Chat-room archive (AC bullet 3).** Left as a no-op with an inline
   `// TODO(Phase 2 chat): ...` comment inside the cancel path — no
   `chat_rooms` table exists yet.
3. **GCal event removal (AC bullet 4).** Left as a no-op with an inline
   `// TODO(#62 GCal sync): ...` comment inside the cancel path — no GCal sync
   service exists; `deleteEvent` is not called.

## Files created

### `supabase/migrations/20260711000001_service_week_notification_types.sql`
Adds `service_week_cancelled` and `service_week_reactivated` to the
`notification_type` enum via two `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
statements. Includes a commented `DOWN` section noting enum-value removal
isn't straightforward in Postgres (mirrors the cluster migrations' style).

### `tests/unit/app/api/service-weeks-cancel-route.test.ts` (new)
### `tests/unit/app/api/service-weeks-reactivate-route.test.ts` (new)
Modeled on `tests/unit/app/api/service-weeks-delete-route.test.ts` (same
Clerk/Supabase mock harness pattern: `makeChain`, `makeSupabaseClient`,
`makeLookup`, `setUpAuth`). The mock chain was extended to support:
- `.update(patch).eq().eq().select().maybeSingle()` for the `service_weeks`
  update.
- `.select().eq().in()` for the pending/accepted invitations recipient
  query (resolves via the chain's `then`).
- `.insert(payload)` on `notifications` (resolves via `then`; the payload is
  captured via an `onInsert` hook for assertions).

Each file covers: 401 (no Clerk userId / no JWT), 403 for `member`,
`set_leader`, `guest` (admin-only), 404 when the update matches no row, 500
on update/invitations-query/notifications-insert errors, the 200 happy path
(correct `is_cancelled` flip, one notification per unique pending/accepted
invitee with the correct `type`/`title`/`link_entity_*`), 200 with zero
recipients (no insert attempted), de-dup of repeated `user_id`s into a single
notification row, and tenant-scoped `eq` call ordering
(`["id", WEEK_ID]` then `["church_group_id", CHURCH_GROUP_ID]`).

## Files modified

### `types/domain.ts`
Added `NotificationType` union (mirrors the DB enum, including the two new
values), following the existing string-literal-union comment style.

### `lib/supabase/types.ts`
- Extended the `@/types/domain` import to include `NotificationType`.
- Added `NotificationsRow` (`id, church_group_id, user_id, type, title, body,
  link_entity_type, link_entity_id, is_read, created_at`).
- Registered `notifications` under `Database.public.Tables`, following the
  `is_cancelled`/`created_at`-optional `Insert` pattern already used for
  `service_weeks` (`id`, `created_at`, `is_read` optional on `Insert`).

### `app/api/service-weeks/[id]/handler.ts`
Added `cancelServiceWeek` and `reactivateServiceWeek`, both thin wrappers
around a new private `setServiceWeekCancelled(req, id, lookup, isCancelled,
notificationType, notificationTitle)` helper that implements the shared
auth → role-guard → JWT → update → notify flow (mirrors `deleteServiceWeek`'s
structure but factored once since the two routes are otherwise identical):
1. `requireAuth` then `requireRole(ctx, ["admin"])` — admin only.
2. JWT via `auth()` → `getToken({ template: "supabase" })`; missing → 401.
3. `service_weeks.update({ is_cancelled })` scoped by
   `.eq("id", id).eq("church_group_id", ctx.churchGroupId)`,
   `.select("*").maybeSingle()`. Error → 500; null data → 404.
4. `invitations.select("user_id").eq("service_week_id", id).in("status",
   ["pending", "accepted"])`. Error → 500. De-duplicated via `Set`.
5. If there are recipients, bulk-insert one `notifications` row per unique
   `user_id` (`church_group_id`, `user_id`, `type`, `title`, `body: null`,
   `link_entity_type: "service_week"`, `link_entity_id: id`), using the
   narrow `as unknown as Database[...]["notifications"]["Insert"][]` cast
   (same trick as `createServiceWeek`). Insert error → 500. Zero recipients
   → insert skipped entirely.
6. Inline TODO comments for the chat-room archive and GCal event removal
   no-ops (open questions 2 and 3), placed after the notification insert.
7. Returns `ok({ serviceWeek: toServiceWeekResponse(data) })` (200).
8. Same `catch (err)` → `ApiException` passthrough / 500 `INTERNAL` fallback
   as the other handlers.

No 409 short-circuit for the already-in-state case — cancelling an
already-cancelled week (or reactivating an already-active one) is allowed
and re-notifies, per the spec's idempotency note.

### `app/api/service-weeks/[id]/cancel/route.ts` (replaced 501 stub)
### `app/api/service-weeks/[id]/reactivate/route.ts` (replaced 501 stub)
Thin `POST` delegators to `cancelServiceWeek`/`reactivateServiceWeek`,
matching the wiring style of `app/api/service-weeks/[id]/route.ts`. The
`notImplemented` import was removed from both.

## Explicitly not touched (per spec's out-of-scope list)
- Hard deletion (`DELETE`, #38 — already implemented).
- Real chat-room archiving (Phase 2 — no table exists).
- Real Google Calendar event removal (#62 — no sync service exists).
- SMS/email dispatch — only the in-app `notifications` row is written.
- Setlists, events, invitations, conflicts rows — never modified by these
  handlers, only `service_weeks.is_cancelled` and new `notifications` rows.
- Any RLS/migration change beyond the two new `notification_type` enum
  values.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — full suite passes: **286 tests, 21 suites**, no
  regressions (up from 206/16 before this change; +2 new suites,
  +~40 tests for cancel/reactivate combined with the pre-existing 39 for
  delete/get/update/list).
- `bun run check:service-role` — passes (no service-role key references
  introduced).
- `bunx prettier --write` applied to the two new test files to match the
  repo's formatting (some pre-existing files were already failing
  `format:check` before this change and were left untouched, out of scope).

## What the Tester should focus on
- The shared `setServiceWeekCancelled` helper — confirm both
  `cancelServiceWeek` and `reactivateServiceWeek` genuinely exercise every
  branch (auth, role, 404, 500 x3, notify) independently, not just via the
  happy path, since they share one implementation.
- Recipient de-duplication: two `invitations` rows for the same `user_id`
  must produce exactly one `notifications` row.
- Only `pending`/`accepted` invitations are notified — `denied`,
  `withdrawn`, `expired` must be excluded (enforced by the `.in("status",
  ["pending", "accepted"])` filter in the recipient query).
- Zero-recipient path must not call `.insert()` on `notifications` at all
  (not even with an empty array).
- Tenant scoping: the `update` call's `eq` sequence must be
  `["id", id]` then `["church_group_id", ctx.churchGroupId]` — never leak
  existence of another tenant's row (404 either way).
- Non-admin roles (`member`, `set_leader`, `guest`) must get 403 before any
  Supabase client is constructed.
- Confirm the new migration's enum values (`service_week_cancelled`,
  `service_week_reactivated`) actually apply cleanly against a real Postgres
  instance if/when RLS integration tests (`bun run test:rls`) are run — this
  was not exercised in this sandbox (no live DB available).
