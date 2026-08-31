# Changes — Issue #71: In-app notification inbox endpoints

## New files

### `lib/notifications/guest-inbox-scope.ts`
`getGuestInboxLinkEntityIds(supabase, userId)` — resolves the set of
notification `link_entity_id`s a guest may see: their own invitation ids, the
service-week ids those invitations point at, and setlist ids belonging to those
weeks. Modeled on `lib/invitations/guest-access.ts` (`"server-only"`, typed
`SupabaseClient<Database>`, never throws, returns `{ linkEntityIds, dbError }`).
Uses ALL invitation rows regardless of status (comment explains why — the
`invitation_withdrawn` notification must stay visible). Returns
`{ linkEntityIds: [], dbError: false }` early when the guest has no invited
weeks. Comment explains why cross-table UUID ids can share one `.in()` filter.

### `app/api/notifications/handler.ts`
Four handlers plus shared helpers:
- `COLUMNS`, `NotificationItem` type, private `mapRow` (snake_case ->
  camelCase), private `resolveGuestScope` (returns `ids: null` for non-guests,
  the scoped list for guests, `dbError` flag).
- `listNotifications` — `GET /api/notifications`. Parses
  `listNotificationsQuerySchema`; 400 on invalid. Guest empty-scope short-circuit.
  Query: `select(COLUMNS, { count: "exact" })` + `.eq("user_id")` +
  `.eq("church_group_id")` + guest `.in("link_entity_id", ids)` +
  `created_at desc, id desc` + `range`. Returns
  `{ notifications, pagination: { page, pageSize, total } }`.
- `getUnreadNotificationCount` — `GET /api/notifications/unread-count`.
  `select("id", { count: "exact", head: true })` + scope filters +
  `.eq("is_read", false)`. Returns `{ unreadCount: count ?? 0 }`.
- `markNotificationRead` — `PATCH /api/notifications/:id/read`. Auth then
  `notificationIdParamSchema` validation (400). Ignores request body. Fetches
  row with scope filters + `maybeSingle`; 404 if missing. Guest: 404 if row's
  `link_entity_id` is null or not in scope (never 403). Already-read -> idempotent
  200 with the row, no write. Otherwise typed `Update` patch `{ is_read: true }`
  + `.select(COLUMNS).maybeSingle()`. Returns `{ notification }`.
- `markAllNotificationsRead` — `POST /api/notifications/mark-all-read`. No body.
  Guest empty-scope -> `{ updatedCount: 0 }`. `update({ is_read: true })` +
  scope filters + `.eq("is_read", false)` + guest `.in` + `.select("id")`.
  Returns `{ updatedCount: (data ?? []).length }`.

All four: `requireAuth` (no `requireRole` — auth is "Any"), JWT -> 401
`UNAUTHENTICATED` if absent, standard try/catch error envelope, generic
`"Internal error"` / `INTERNAL` / 500 for any DB error including the guest-scope
lookup.

### `tests/unit/app/api/notifications-inbox-route.test.ts`
32 tests across all four handlers: 401 paths, member happy paths, camelCase
mapping, pagination (defaults, range math, page-past-end, null count, invalid
params), 500 on DB error, guest scoping (scoped `.in` filter, zero-invitation
short-circuit, scope-lookup error), idempotent PATCH, 404 (missing / other user
/ out-of-scope guest / null link for guest), non-UUID -> 400, mark-all counts
and guest filtering.

## Modified files

### `schemas/notifications.ts`
Added `listNotificationsQuerySchema` (+ `ListNotificationsQuery` type) copied
from `schemas/audit-log.ts` with `pageSize` default 20, and
`notificationIdParamSchema = z.string().uuid()`. Existing exports untouched.

### `app/api/notifications/route.ts`
### `app/api/notifications/unread-count/route.ts`
### `app/api/notifications/mark-all-read/route.ts`
### `app/api/notifications/[id]/read/route.ts`
Replaced the `notImplemented` 501 stubs with thin delegations to
`@/app/api/notifications/handler`. The `[id]/read` route awaits
`params: Promise<{ id: string }>` and passes `id` through. Removed the unused
`notImplemented` imports.

## Not changed (per spec)
No migration, no `lib/supabase/types.ts` change, no `preferences/*` change, no
type filter, no audit-log writes, no UI.

## Verification
`bun run lint`, `bun run typecheck`, `bun run test` (3050 passed) all green.

## Tester focus
- Guest scoping correctness: the mixed-table `.in("link_entity_id", ...)` list
  and the "all invitation statuses" decision.
- PATCH 404-not-403 anti-enumeration for the three distinct miss cases.
- Idempotent already-read PATCH (200, no write).
- `head: true` count query shape for unread-count.
