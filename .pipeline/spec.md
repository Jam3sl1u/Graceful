# Spec — Issue #71: In-app notification inbox endpoints

## OPEN QUESTIONS

None. Everything below is resolved against the current code; the judgement
calls are recorded under "Decisions" with their rationale.

## Current state (verified in this worktree)

- The 4 route files already exist but return `notImplemented(...)` 501 stubs:
  - `app/api/notifications/route.ts`
  - `app/api/notifications/unread-count/route.ts`
  - `app/api/notifications/[id]/read/route.ts`
  - `app/api/notifications/mark-all-read/route.ts`
- `app/api/notifications/preferences/{handler,route}.ts` are fully implemented
  (#70) — same directory, different feature. Do not touch them.
- The `notifications` table exists (`supabase/migrations/20260702000005_cluster_5_partial.sql`):
  `id, church_group_id, user_id, type, title, body, link_entity_type,
  link_entity_id, is_read, created_at`. Indexes already cover
  `(user_id, is_read)` and `(user_id, created_at desc)`.
- RLS (`supabase/migrations/20260704000001_rls_policies.sql`) already restricts
  SELECT and UPDATE on `notifications` to `church_group_id = auth_church_group_id()
  AND user_id = auth_user_id()`. **No migration is needed for this issue.**
- `lib/supabase/types.ts` already has `NotificationsRow` + the `notifications`
  table entry (Row/Insert/Update). **No changes needed there.**
- Producers (#69) already write rows with these `link_entity_type` values:
  `"invitation"`, `"service_week"`, `"setlist"`, `"conflict"`,
  `"google_calendar"` (the last with `link_entity_id = NULL`).
- `lib/invitations/guest-access.ts` (`guestHasWeekAccess`) is the existing guest
  scoping helper for single-week reads.

## Scope

Implement the 4 inbox endpoints only. No migration, no UI, no SMS/email, no
type filter, no audit-log writes, no rate limiting.

## Files to create

### 1. `lib/notifications/guest-inbox-scope.ts` (new)

Pattern to copy: `lib/invitations/guest-access.ts` (same shape — `"server-only"`
import, typed `SupabaseClient<Database>` param, never throws, returns a
`dbError` flag instead of throwing).

```ts
export type GuestInboxScope = { linkEntityIds: string[]; dbError: boolean };

export async function getGuestInboxLinkEntityIds(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<GuestInboxScope>;
```

Behaviour:

1. `supabase.from("invitations").select("id, service_week_id").eq("user_id", userId)`
   — **all statuses**, no status filter (see Decisions). On error return
   `{ linkEntityIds: [], dbError: true }`.
2. `invitationIds` = the returned `id`s; `weekIds` = unique `service_week_id`s.
3. If `weekIds.length === 0`, return `{ linkEntityIds: [], dbError: false }`.
4. `supabase.from("setlists").select("id").in("service_week_id", weekIds)`.
   On error return `{ linkEntityIds: [], dbError: true }`.
5. Return `{ linkEntityIds: [...new Set([...invitationIds, ...weekIds, ...setlistIds])], dbError: false }`.

Add a comment explaining that ids from different tables can be mixed in one
`.in("link_entity_id", ...)` filter because they are all UUID primary keys and
therefore globally unique — that is why no per-`link_entity_type` `.or()` group
is needed.

### 2. `app/api/notifications/handler.ts` (new)

Pattern to copy: `app/api/church-group/audit-log/handler.ts` for the paginated
query (`page`/`pageSize` -> `range(from, to)` + `count: "exact"` + `created_at`
desc with `id` desc tiebreak), and `app/api/notifications/preferences/handler.ts`
for the auth/JWT/error-envelope boilerplate.

Shared, module-level:

```ts
const COLUMNS = "id, type, title, body, link_entity_type, link_entity_id, is_read, created_at";

export type NotificationItem = {
  id: string;
  type: NotificationType;          // from "@/types/domain"
  title: string;
  body: string | null;
  linkEntityType: string | null;
  linkEntityId: string | null;
  isRead: boolean;
  createdAt: string;               // ISO timestamp
};
```

plus a private `mapRow(row): NotificationItem` (snake_case -> camelCase), and a
private helper that resolves the guest scope once per request, e.g.

```ts
// Returns null for non-guest callers (no extra filtering), the scoped id list
// for guests. Callers must handle the dbError case as a 500.
async function resolveGuestScope(
  supabase: SupabaseClient<Database>,
  ctx: AuthContext,
): Promise<{ ids: string[] | null; dbError: boolean }>;
```

Exported handlers (every one wrapped in the repo's standard
`try { ... } catch (err) { if (err instanceof ApiException) return fail(err.message, err.code, err.status); return fail("Internal error", ErrorCode.INTERNAL, 500); }`):

```ts
export async function listNotifications(req: NextRequest, lookup?: UserLookup): Promise<Response>;
export async function getUnreadNotificationCount(req: NextRequest, lookup?: UserLookup): Promise<Response>;
export async function markNotificationRead(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>;
export async function markAllNotificationsRead(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

Common to all four: `await requireAuth(req, lookup)`; **no `requireRole` call**
— PRD §22.12 auth is "Any", and all 4 roles including `guest` must work. Then
`const { getToken } = await auth(); const jwt = await getToken();` -> 401
`UNAUTHENTICATED` if falsy -> `getSupabaseClient(jwt)`. Every query additionally
filters `.eq("user_id", ctx.userId).eq("church_group_id", ctx.churchGroupId)` as
defense in depth on top of RLS.

**`listNotifications`** — `GET /api/notifications`

- Parse `listNotificationsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))`;
  invalid -> 400 `VALIDATION_FAILED`.
- Guest with an empty scope -> return the empty page without querying:
  `ok({ notifications: [], pagination: { page, pageSize, total: 0 } })`.
- Query: `.from("notifications").select(COLUMNS, { count: "exact" })`, the two
  `.eq` scope filters, `.in("link_entity_id", scopeIds)` when the caller is a
  guest, `.order("created_at", { ascending: false }).order("id", { ascending: false })`,
  `.range((page - 1) * pageSize, (page - 1) * pageSize + pageSize - 1)`.
- Response: `ok({ notifications: NotificationItem[], pagination: { page, pageSize, total: count ?? 0 } })`.

**`getUnreadNotificationCount`** — `GET /api/notifications/unread-count`

- No query params.
- Guest with empty scope -> `ok({ unreadCount: 0 })`.
- Query: `.select("id", { count: "exact", head: true })` + scope filters +
  `.eq("is_read", false)` (+ guest `.in`).
- Response: `ok({ unreadCount: count ?? 0 })`.

**`markNotificationRead`** — `PATCH /api/notifications/:id/read`

- After `requireAuth`, validate the path param with
  `notificationIdParamSchema.safeParse(id)`; invalid -> 400 `VALIDATION_FAILED`
  (same auth-then-validate order as `withdrawInvitation` in
  `app/api/invitations/handler.ts`).
- Ignore the request body entirely (do not call `req.json()`).
- Fetch the row first: `.select(COLUMNS).eq("id", id)` + scope filters +
  `.maybeSingle()`. DB error -> 500; no row -> 404 `NOT_FOUND`.
- Guest: if the row's `link_entity_id` is null or not in the scoped id list ->
  404 `NOT_FOUND` (never 403 — matches the anti-enumeration rule in
  `app/api/service-weeks/[id]/handler.ts`).
- If already `is_read === true`, skip the write and return the row as-is
  (idempotent 200, not 409).
- Otherwise `.update(patch).eq("id", id)` + scope filters + `.select(COLUMNS).maybeSingle()`,
  where `const patch: Database["public"]["Tables"]["notifications"]["Update"] = { is_read: true };`
  (typed-patch pattern from `app/api/conflicts/handler.ts`). DB error or missing
  row -> 500 / 404 respectively.
- Response: `ok({ notification: NotificationItem })`.

**`markAllNotificationsRead`** — `POST /api/notifications/mark-all-read`

- No body parsing, no query params.
- Guest with empty scope -> `ok({ updatedCount: 0 })`.
- `.update({ is_read: true })` (typed patch as above) + scope filters +
  `.eq("is_read", false)` (+ guest `.in`) + `.select("id")`. DB error -> 500.
- Response: `ok({ updatedCount: (data ?? []).length })`.

## Files to modify

### 3. `schemas/notifications.ts`

Add (keep the existing exports untouched, including the placeholder
`notificationsSchema`):

```ts
export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationIdParamSchema = z.string().uuid();
```

Copy the pagination schema shape verbatim from `schemas/audit-log.ts` (only the
`pageSize` default differs: 20 for an inbox feed).

### 4-7. The four route files

Replace the `notImplemented` bodies with thin delegations. Pattern to copy:
`app/api/notifications/preferences/route.ts`, and
`app/api/conflicts/[id]/resolve/route.ts` for the dynamic-param route.

- `app/api/notifications/route.ts`:
  `export async function GET(req: NextRequest): Promise<Response> { return listNotifications(req); }`
- `app/api/notifications/unread-count/route.ts`:
  `export async function GET(req: NextRequest): Promise<Response> { return getUnreadNotificationCount(req); }`
- `app/api/notifications/mark-all-read/route.ts`:
  `export async function POST(req: NextRequest): Promise<Response> { return markAllNotificationsRead(req); }`
- `app/api/notifications/[id]/read/route.ts`:
  ```ts
  type Ctx = { params: Promise<{ id: string }> };
  export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
    const { id } = await params;
    return markNotificationRead(req, id);
  }
  ```

All four import from `@/app/api/notifications/handler`. Remove the now-unused
`notImplemented` imports.

## Edge cases the implementation must handle

1. **Guest scoping (AC bullet 5)**: a guest sees only notifications whose
   `link_entity_id` is one of their own invitation ids, one of the service-week
   ids they were invited to, or a setlist id belonging to one of those weeks.
   This matters for a user demoted from `member` to `guest`, who still owns rows
   for weeks they were never invited to.
2. **Guest with zero invitations**: empty inbox, `unreadCount: 0`,
   `updatedCount: 0`, and 404 on any PATCH — no crash, no unfiltered query.
3. **Notifications with `link_entity_id = NULL`** (e.g. the
   `google_calendar_reauth_required` row written by
   `supabase/migrations/20260716000001_google_calendar_sync.sql`) are excluded
   for guests by the `.in(...)` filter, and always visible to the other 3 roles.
4. **Already-read PATCH** is idempotent: 200 with the unchanged item, never 409.
5. **PATCH on an id that does not exist, belongs to another user, or is outside
   a guest's scope**: 404 `NOT_FOUND` — never 403, never a distinguishable
   message between those cases.
6. **PATCH with a non-UUID id**: 400 `VALIDATION_FAILED`.
7. **Invalid pagination** (`page=0`, `page=abc`, `pageSize=0`, `pageSize=101`):
   400 `VALIDATION_FAILED`. Missing params fall back to `page=1`, `pageSize=20`.
8. **Page past the end**: 200 with `notifications: []` and the real `total`.
9. **`mark-all-read` with nothing unread**: 200 `{ updatedCount: 0 }`.
10. **Missing Supabase JWT** (`getToken()` returns null): 401 `UNAUTHENTICATED`,
    on all four endpoints.
11. **Any Supabase error**, including an error from the guest-scope lookup:
    500 `INTERNAL` with the generic `"Internal error"` message — never leak the
    driver error.
12. **`count` returned as `null`** by PostgREST: coerce to `0`.
13. **Ordering stability**: `created_at desc, id desc` so pagination cannot skip
    or duplicate rows sharing a timestamp (bulk inserts write identical
    `created_at` values — see the fan-out inserts in
    `app/api/setlists/[id]/handler.ts`).

## Decisions (recorded so the reviewer does not re-litigate them)

- **"Invited weeks" means any invitation row, regardless of status.** This
  deliberately differs from `guestHasWeekAccess`/`GUEST_ACCESS_STATUSES`
  (`pending`/`accepted`), which gates *content* access. Using live statuses here
  would make the `invitation_withdrawn` notification vanish at the exact moment
  it is written (the withdraw path in `app/api/invitations/handler.ts` sets
  `status = 'withdrawn'` immediately before inserting it), so the guest could
  never learn they were withdrawn — which contradicts the issue's "source of
  truth for did I get notified about this". Add a comment saying so.
- **No type filter.** PRD §22.12 mentions "filterable by type", but §13.2 marks
  "Filter by type" as Phase 2 and the issue's ACs do not ask for it. Out of
  scope.
- **No `requireRole`.** Auth is "Any" (all 4 roles); guest access is narrowed by
  the scope filter, not by a role gate.
- **No audit-log writes.** Reading and marking one's own inbox is not an audited
  admin action; `writeAuditLog` is not used here.
- **No new migration.** The table, indexes, RLS policies, and TypeScript row
  types all already exist.

## Verification

Run from the worktree root with Bun (never npm/npx):

- `bun run lint`
- `bun run typecheck`
- `bun run test`

Unit tests belong in `tests/unit/app/api/notifications-inbox-route.test.ts`;
copy the Clerk/Supabase mocking harness from
`tests/unit/app/api/audit-log-route.test.ts` (it already models
`select -> order -> order -> range` with `count`), extending the fake client
with `in`, `update`, `maybeSingle`, and `head: true` count support. Handlers
take an injectable `lookup?: UserLookup` precisely so tests can vary
`ctx.role` across `admin` / `set_leader` / `member` / `guest`.
