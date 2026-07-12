# Spec — Issue #39: Service week cancel/reactivate (BR-17)

Implement `POST /api/service-weeks/:id/cancel` and `POST /api/service-weeks/:id/reactivate`.
These are pure status-flag flips on `service_weeks.is_cancelled` plus notification fan-out.
Do NOT touch setlists, events, invitations, conflicts, or any other child rows.

---

## OPEN QUESTIONS (non-blocking — defaults chosen below; change only if a human overrides)

1. **Notification enum value.** The `notification_type` Postgres enum
   (`supabase/migrations/20260702000005_cluster_5_partial.sql`) has NO value for a
   cancelled/reactivated service week. **Default chosen:** add two new enum values via a
   new migration (`service_week_cancelled`, `service_week_reactivated`) — see "Files to
   create" below. If you'd rather reuse an existing value, the closest is
   `scheduling_conflict`, but it's semantically wrong; the migration path is the default.

2. **Chat-room archive flag (AC bullet 3).** There is NO `chat_rooms` table and NO chat
   column on `service_weeks` — the cluster-5 migration explicitly defers all chat objects
   to Phase 2. There is nowhere to set an "archived" flag today. **Default chosen:**
   implement this AC as a no-op with an inline `// TODO(Phase 2 chat): archive chat room
   placeholder for this week — no chat table exists yet` comment inside the cancel handler.
   Do NOT invent a column or table for it.

3. **GCal event removal (AC bullet 4).** No GCal-sync service exists
   (`lib/google-calendar/client.ts` throws "not implemented"). **Default chosen:**
   implement as a no-op stub with an inline `// TODO(#62 GCal sync): remove synced Google
   Calendar events for this week's events` comment. Do NOT call `deleteEvent` (it throws).

---

## Current state (already true — do not redo)

- `service_weeks.is_cancelled boolean not null default false` already exists in the DB
  (`supabase/migrations/20260702000003_cluster_3_scheduling_core.sql`) and in
  `lib/supabase/types.ts` (`ServiceWeeksRow.is_cancelled`). No schema change to
  `service_weeks` is needed.
- Route files exist as 501 stubs and must be filled in:
  - `app/api/service-weeks/[id]/cancel/route.ts`
  - `app/api/service-weeks/[id]/reactivate/route.ts`
- `notifications` table EXISTS in the DB
  (`supabase/migrations/20260702000005_cluster_5_partial.sql`) but is NOT in
  `lib/supabase/types.ts` — you must add it (see below).
- RLS: `notifications_insert_leader_admin` allows INSERT only when
  `church_group_id = auth_church_group_id() AND auth_is_leader_or_admin()`. Admin qualifies.
  Rows inserted must set `church_group_id` to the caller's group.

---

## Files to create

### 1. `supabase/migrations/20260711000001_service_week_notification_types.sql`
Add two enum values for the cancel/reactivate notifications. Each `ADD VALUE` is its own
statement.

```sql
-- Issue #39 (BR-17): notification types for service week cancel/reactivate.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'service_week_cancelled';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'service_week_reactivated';
```

Include a commented `-- ============ DOWN ============` section noting enum-value removal
is not straightforward in Postgres (mirror the DOWN-comment style used in the cluster
migrations; a real down is not required).

---

## Files to modify

### 2. `types/domain.ts`
Add a `NotificationType` union mirroring the DB enum (including the two new values). Keep
the existing string-literal-union comment style:
```ts
export type NotificationType =
  | "set_invitation"
  | "invitation_reminder"
  | "invitation_accepted"
  | "invitation_denied"
  | "practice_reminder"
  | "setlist_released"
  | "scheduling_conflict"
  | "chat_mention"
  | "devotion_shared"
  | "new_church_document"
  | "google_calendar_event"
  | "service_week_cancelled"
  | "service_week_reactivated";
```

### 3. `lib/supabase/types.ts`
Add a `NotificationsRow` type and register the `notifications` table in
`Database["public"]["Tables"]`. Follow the exact style of the existing `InvitationsRow` /
`invitations` entries. Import `NotificationType` from `@/types/domain` (extend the existing
import line).

Row shape (mirror the DB columns from the cluster-5 migration exactly):
```ts
type NotificationsRow = {
  id: string;
  church_group_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link_entity_type: string | null;
  link_entity_id: string | null;
  is_read: boolean;
  created_at: string;
};
```
Table entry (match the `is_cancelled`/`created_at`-optional Insert style already used for
`service_weeks`):
```ts
notifications: {
  Row: NotificationsRow;
  Insert: Omit<NotificationsRow, "id" | "created_at" | "is_read"> & {
    id?: string;
    created_at?: string;
    is_read?: boolean;
  };
  Update: Partial<NotificationsRow>;
  Relationships: [];
};
```

### 4. `app/api/service-weeks/[id]/handler.ts` (add two exported functions)
Add `cancelServiceWeek` and `reactivateServiceWeek` alongside the existing handlers.
Copy the structure of the existing `deleteServiceWeek` in this same file (auth → role
guard → JWT → fetch/mutate → notify). Signatures:

```ts
export async function cancelServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>

export async function reactivateServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>
```

Shared behavior for BOTH:
1. `const ctx = await requireAuth(req, lookup);`
2. `requireRole(ctx, ["admin"]);` — admin only (matches DELETE; the issue frames this as an
   admin action). Members/set_leaders/guests get 403 FORBIDDEN.
3. Get supabase client via the `auth()` → `getToken({ template: "supabase" })` pattern
   already used in `deleteServiceWeek`; missing JWT → 401 UNAUTHENTICATED.
4. Update `service_weeks` scoped by `.eq("id", id).eq("church_group_id", ctx.churchGroupId)`,
   setting `{ is_cancelled: true }` (cancel) or `{ is_cancelled: false }` (reactivate).
   Use `.select("*").maybeSingle()`. If `error` → 500 INTERNAL. If `data` is null → 404
   NOT_FOUND (row missing or wrong tenant — do not leak existence).
5. Fetch affected recipients: query `invitations` with
   `.select("user_id").eq("service_week_id", id).in("status", ["pending", "accepted"])`.
   On error → 500 INTERNAL. De-duplicate `user_id`s.
6. If there are recipients, bulk-insert one `notifications` row per unique `user_id`:
   - `church_group_id: ctx.churchGroupId`
   - `user_id`
   - `type`: `"service_week_cancelled"` (cancel) / `"service_week_reactivated"` (reactivate)
   - `title`: cancel → `"Service week cancelled"`; reactivate → `"Service week reactivated"`
   - `body`: null (keep minimal; do not fabricate copy)
   - `link_entity_type: "service_week"`, `link_entity_id: id`
   - Use the same narrow-cast-to-Insert trick used in `createServiceWeek`
     (`... as unknown as Database["public"]["Tables"]["notifications"]["Insert"]`) if the
     hand-rolled Insert type complains.
   - If the notifications insert `error` → 500 INTERNAL. (Notification is part of the AC,
     so a failed insert is a real failure, not fire-and-forget.)
   - If there are zero recipients, skip the insert entirely (do not insert an empty array).
7. Chat-room archive: inline no-op TODO comment (see OPEN QUESTION 2). Cancel handler only.
8. GCal removal: inline no-op TODO comment (see OPEN QUESTION 3). Cancel handler only.
9. Return `ok({ serviceWeek: toServiceWeekResponse(data) })` (200) using
   `toServiceWeekResponse` (already imported from `../handler` in this file). Reuse it.
10. `catch (err)`: `if (err instanceof ApiException) return fail(err.message, err.code,
    err.status); return fail("Internal error", ErrorCode.INTERNAL, 500);` — copy verbatim
    from the other handlers.

Idempotency note: cancelling an already-cancelled week (or reactivating an already-active
one) is allowed and still returns 200 with the (re-)notification sent — the AC does not ask
for a "no change" short-circuit, and re-notify on reactivate is explicitly desired. Do NOT
add a 409 for the already-in-state case.

### 5. `app/api/service-weeks/[id]/cancel/route.ts` (replace stub)
Mirror the wiring style of `app/api/service-weeks/[id]/route.ts`:
```ts
import { NextRequest } from "next/server";
import { cancelServiceWeek } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return cancelServiceWeek(req, id);
}
```
Remove the `notImplemented` import.

### 6. `app/api/service-weeks/[id]/reactivate/route.ts` (replace stub)
Same shape, calling `reactivateServiceWeek`.

---

## Tests to create

### 7. `tests/unit/app/api/service-weeks-cancel-route.test.ts`
Model closely on `tests/unit/app/api/service-weeks-delete-route.test.ts` (same
Clerk/supabase mock harness: `makeChain`, `makeSupabaseClient`, `makeLookup`, `setUpAuth`).
Import `cancelServiceWeek` from `@/app/api/service-weeks/[id]/handler`.

Extend the mock chain to support the new call shapes:
- `.update(...).eq().eq().select().maybeSingle()` (add an `update` fixture/branch).
- `.select(...).eq().in(...)` (add `in: jest.fn(() => chain)` to the chain; it resolves via
  `then`).
- `.insert(...)` on the `notifications` table (add an `insert` branch that resolves via
  `then`, capturing the inserted payload for assertions).

Cover:
- 401 when Clerk userId is null (lookup not consulted).
- 401 when getToken yields no JWT.
- 403 for each of `member`, `set_leader`, `guest` (admin-only).
- 404 when the update matches no row (`update` returns `{ data: null, error: null }`).
- 500 when the update errors.
- 500 when the invitations recipient query errors.
- 500 when the notifications insert errors.
- 200 happy path: `is_cancelled` set true, response body
  `data.serviceWeek.isCancelled === true`; one notification row inserted per unique
  pending/accepted invitee with `type: "service_week_cancelled"`,
  `link_entity_type: "service_week"`, `link_entity_id: WEEK_ID`.
- 200 with zero pending/accepted invitations → no notifications insert attempted.
- De-dup: two invitations for the same `user_id` produce a single notification row.
- Tenant scoping: the update is scoped to `["id", WEEK_ID]` then
  `["church_group_id", CHURCH_GROUP_ID]` (assert the eq-call sequence, mirroring the delete
  test's "scopes the delete" case).

### 8. `tests/unit/app/api/service-weeks-reactivate-route.test.ts`
Same as above for `reactivateServiceWeek`: `is_cancelled` set false,
`type: "service_week_reactivated"`, `data.serviceWeek.isCancelled === false`, re-notify
pending/accepted invitees.

---

## Edge cases the implementation MUST handle
- Missing/other-tenant week id → 404 NOT_FOUND (never leak existence).
- Non-admin caller → 403 FORBIDDEN before any DB write.
- Missing Clerk auth / missing supabase JWT → 401 UNAUTHENTICATED.
- Zero pending/accepted invitations → succeed with no notification insert (do not error).
- Duplicate `user_id` across multiple invitations for the same week → one notification each.
- Only `pending` and `accepted` invitations are notified — `denied`, `withdrawn`, `expired`
  are excluded.
- Child rows (setlist, events, invitations, conflicts) are NEVER modified — only the
  `is_cancelled` flag and new `notifications` rows are written.
- DB errors at each step (update, invitations select, notifications insert) → 500 INTERNAL.

## Patterns to follow (copy from these exact files)
- Handler structure, auth/JWT/role guards, error handling: `deleteServiceWeek` in
  `app/api/service-weeks/[id]/handler.ts`.
- Narrow Insert cast: `createServiceWeek` in `app/api/service-weeks/handler.ts`.
- Route → handler wiring: `app/api/service-weeks/[id]/route.ts`.
- Response envelope: `ok`/`fail` from `lib/api/response.ts`; codes from `lib/api/errors.ts`.
- Test harness: `tests/unit/app/api/service-weeks-delete-route.test.ts`.
- `types.ts` table registration style: existing `invitations` / `service_weeks` entries.

## Out of scope (do not implement)
- Hard deletion (#38 — already implemented via DELETE).
- Real chat-room archiving (Phase 2 — no table exists).
- Real Google Calendar event removal (#62 — no sync service exists).
- SMS/email dispatch of the notification (only the in-app `notifications` row is required).
- Any RLS/migration change beyond adding the two `notification_type` enum values.
