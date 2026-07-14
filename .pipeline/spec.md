# Spec — Issue #47: Conflict resolution flow (3 paths, manual-only)

## OPEN QUESTIONS

None that block implementation. One codebase-vs-AC gap is called out and
resolved below (see **NOTE: Google Calendar deletion**) — it is handled the
same honest way `accept_invitation` handled the create side, not left as a
silent hole. Implement as specified.

---

## Summary

Wire up the two already-scaffolded (currently `notImplemented` 501) conflict
endpoints:

- `GET /api/conflicts` — list OPEN conflicts for the caller's church group
  (set_leader / admin only).
- `POST /api/conflicts/:id/resolve` — resolve one conflict via one of three
  manual paths: `withdraw`, `member_reconfirmed`, `admin_dismissed`.

This is manual-only. Do NOT implement any AI replacement suggestion (Phase 4,
explicitly out of scope). Do not touch `replacement_suggestion_user_id`.

Follow the existing handler style of `app/api/invitations/handler.ts`
(`withdrawInvitation` / `createInvitation`) and the multi-query in-memory-join
style of `app/api/church-group/members/handler.ts` (`getChurchGroupMembers`).
Use a plain RLS-scoped route handler — **no new SQL migration / RPC is
required** (all writes are permitted to set_leader/admin under existing RLS;
see "Why no RPC" below).

---

## Current state (verified)

- `app/api/conflicts/route.ts` and
  `app/api/conflicts/[id]/resolve/route.ts` both return `notImplemented(...)`.
- `conflicts` table (migration `20260702000003_cluster_3_scheduling_core.sql`)
  columns: `id, church_group_id, invitation_id, triggered_by, trigger_reason,
  replacement_suggestion_user_id, resolved_at, resolution_type, created_at`.
  An OPEN conflict = `resolved_at IS NULL`.
- DB enum `resolution_type` = `('replaced','withdrawn','member_reconfirmed','admin_dismissed')`.
- `invitation_status` enum = `('pending','accepted','denied','withdrawn')`.
- RLS (`20260704000001_rls_policies.sql`): `conflicts` SELECT/UPDATE are
  leader/admin + same-group (`conflicts_select_leader_admin`,
  `conflicts_update_leader_admin`); `invitations` UPDATE is leader/admin
  (already used by `withdrawInvitation`); `event_attendees` DELETE is any
  same-tenant authenticated user (`event_attendees_delete_tenant`);
  `notifications` INSERT is leader/admin. So an admin/set_leader route handler
  can do every write this issue needs directly.
- Conflicts are recorded on ACCEPTED invitations by
  `record_availability_conflict` (`20260713000001_conflict_notification.sql`).
- `schemas/conflicts.ts` currently only has an empty placeholder
  `conflictsSchema` — replace/extend it (see below).
- Notification type `invitation_withdrawn` already exists and is used by
  `withdrawInvitation` (#43).

### Type mismatch to fix (required)

`types/domain.ts` currently declares:
```ts
export type ResolutionType = "withdraw" | "member_reconfirmed" | "admin_dismissed";
```
This does NOT match the DB enum (`withdrawn`, not `withdraw`; and it is missing
`replaced`). `lib/supabase/types.ts` types `conflicts.resolution_type` as
`ResolutionType | null`, so writing the correct DB value `'withdrawn'` is
currently a TS error. **Fix `types/domain.ts` to match the DB enum exactly:**
```ts
export type ResolutionType = "replaced" | "withdrawn" | "member_reconfirmed" | "admin_dismissed";
```
`ResolutionType` is referenced only in `types/domain.ts` and
`lib/supabase/types.ts` — this change is safe. The API request field
(`resolution`, below) is a separate concept and keeps the `withdraw` spelling.

---

## Files

### 1. `types/domain.ts` (modify)
Update `ResolutionType` to the 4 DB enum values (see above).

### 2. `schemas/conflicts.ts` (modify)
Replace the placeholder with a real request schema. Keep style consistent with
`schemas/invitations.ts` (zod).
```ts
import { z } from "zod";

export const resolveConflictSchema = z.object({
  resolution: z.enum(["withdraw", "member_reconfirmed", "admin_dismissed"]),
});
export type ResolveConflictInput = z.infer<typeof resolveConflictSchema>;
```
(The old empty `conflictsSchema` export may be removed; grep confirms it has no
importers.)

### 3. `app/api/conflicts/handler.ts` (create)
New file holding both handler functions. Mirror imports/error handling of
`app/api/invitations/handler.ts` (requireAuth/requireRole, getSupabaseClient,
ok/fail, ApiException/ErrorCode, writeAuditLog, `try/catch` with the same
`ApiException`→`fail` fallback).

#### `getOpenConflicts(req: NextRequest, lookup?: UserLookup): Promise<Response>`
- `requireAuth`; `requireRole(ctx, ["admin", "set_leader"])`.
- Get supabase JWT client (same 401-on-missing-jwt pattern as siblings).
- Query `conflicts` where `church_group_id = ctx.churchGroupId` AND
  `resolved_at IS NULL` (`.is("resolved_at", null)`), order by `created_at`.
- Then, following the multi-query in-memory-join pattern of
  `getChurchGroupMembers` (do NOT rely on Supabase nested-join relationships —
  `Relationships: []` in the hand-rolled types), fetch the related rows by id
  sets:
  - `invitations` (id in conflict.invitation_id set): select
    `id, user_id, service_week_id, status`.
  - `users` (id in the invitations' user_id set): select `id, name`.
  - `service_weeks` (id in the invitations' service_week_id set): select
    `id, service_date, title`.
- On any query `.error`, return `fail("Internal error", ErrorCode.INTERNAL, 500)`.
- Return `ok({ conflicts })` where each item is:
  ```ts
  type OpenConflict = {
    id: string;                 // conflicts.id
    invitationId: string;
    memberId: string;           // invitation.user_id
    memberName: string;         // users.name (fallback "" if missing)
    serviceWeekId: string;
    serviceDate: string;
    serviceWeekTitle: string | null;
    invitationStatus: InvitationStatus;
    triggerReason: string | null;
    createdAt: string;
  };
  ```
  Export the `OpenConflict` type. If a joined row is missing, do not drop the
  conflict — keep it with safe fallbacks (name `""`, and if the invitation row
  itself is missing, emit the conflict with empty member/week fields rather
  than dropping it).

#### `resolveConflict(req, id, lookup?): Promise<Response>`
Signature: `(req: NextRequest, id: string, lookup?: UserLookup) => Promise<Response>`.

1. `requireAuth`; `requireRole(ctx, ["admin", "set_leader"])`.
2. Parse body with `resolveConflictSchema.safeParse(await req.json().catch(() => null))`;
   on failure → `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
3. Get supabase JWT client (401 if jwt missing).
4. Load the conflict: `conflicts` where `id = id` AND
   `church_group_id = ctx.churchGroupId`, `.maybeSingle()`.
   - `.error` → 500. Missing → `fail("Not found", ErrorCode.NOT_FOUND, 404)`
     (missing / wrong-group indistinguishable, matching repo 404-not-403
     convention).
5. Idempotency guard: if `conflict.resolved_at !== null` →
   `fail("Conflict already resolved", ErrorCode.CONFLICT, 409)` with no side
   effects.
6. Branch on `resolution`:

   **`withdraw`** (reuses #43 withdrawal logic — see `withdrawInvitation`; NOTE
   the invitation here is `accepted`, not `pending`, so do NOT copy #43's
   `status !== "pending"` 409 guard):
   - Load the invitation (`invitations` where `id = conflict.invitation_id`
     AND `church_group_id = ctx.churchGroupId`, `.maybeSingle()`). `.error` →
     500. If missing → 404.
   - Flip invitation `status → "withdrawn"` via `.update({ status: "withdrawn" })`
     scoped by id + church_group_id. `.error` → 500.
   - Remove the member from the roster / reopen the slot: delete
     `event_attendees` rows for this member across the invitation's service
     week. `event_attendees` has no `service_week_id` and delete cannot join,
     so first select `events.id` where `service_week_id =
     invitation.service_week_id` AND `church_group_id = ctx.churchGroupId`,
     then `event_attendees.delete().in("event_id", eventIds).eq("user_id",
     invitation.user_id)`. Guard the empty-eventIds case (skip the delete if
     the week has no events — idempotent no-op). `.error` on either → 500.
   - **Google Calendar deletion:** see NOTE below — leave a
     `// TODO(#62): delete member's Google Calendar events for this week`
     comment; there is nothing to delete yet.
   - Notify the member (reuse #43): insert into `notifications`
     `{ church_group_id: conflict.church_group_id, user_id: invitation.user_id,
     type: "invitation_withdrawn", title: "Invitation withdrawn",
     body: "Your set invitation was withdrawn", link_entity_type: "invitation",
     link_entity_id: invitation.id }`. `.error` → 500. (Same insert shape as
     `withdrawInvitation`.)
   - Set `dbResolutionType = "withdrawn"`.

   **`member_reconfirmed`** — member stays on the roster; make NO change to
   `invitations` or `event_attendees`. Set `dbResolutionType = "member_reconfirmed"`.

   **`admin_dismissed`** — member stays despite the flag; make NO change to
   `invitations` or `event_attendees`. Set `dbResolutionType = "admin_dismissed"`.

7. Mark the conflict resolved LAST (so a mid-operation failure leaves the
   conflict open and safely retryable): `conflicts.update({ resolution_type:
   dbResolutionType, resolved_at: new Date().toISOString() })` scoped by id +
   church_group_id, `.select("*").maybeSingle()`. `.error` → 500; missing → 404.
8. `writeAuditLog(supabase, { action: "conflict.resolved", entityType:
   "conflict", entityId: id, metadata: { resolution, invitation_id:
   conflict.invitation_id } })`.
9. Return `ok({ conflict })` with the updated conflict row mapped to a small
   response object (at minimum `{ id, resolutionType, resolvedAt }`; you may
   reuse the row shape). 200.
10. Wrap the whole body in the standard `try/catch` →
    `ApiException`/`INTERNAL 500` fallback used across the repo.

### 4. `app/api/conflicts/route.ts` (modify)
Replace the stub with:
```ts
import { NextRequest } from "next/server";
import { getOpenConflicts } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getOpenConflicts(req);
}
```

### 5. `app/api/conflicts/[id]/resolve/route.ts` (modify)
Replace the stub with (mirror `app/api/invitations/[id]/route.ts` param
handling):
```ts
import { NextRequest } from "next/server";
import { resolveConflict } from "@/app/api/conflicts/handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return resolveConflict(req, id);
}
```

---

## NOTE: Google Calendar deletion

AC lists "GCal events deleted" for the withdraw path, but the codebase has NO
per-attendee Google Calendar sync yet: `accept_invitation`
(`20260712000001_accept_invitation_rpc.sql`) explicitly defers calendar
creation with `TODO(#62): Google Calendar sync on accept`, and
`events.google_calendar_event_id` is for the leader-created service event, not
per-member events. There is therefore nothing to delete. Do NOT build GCal
integration in this issue — leave the `TODO(#62)` comment on the withdraw path
(as above) so it is picked up when #62 lands. This mirrors how the create side
was handled. Downstream stages: this is intentional, not a defect.

## NOTE: AC "manual replacement always available"

This is satisfied without any new endpoint: the withdraw path reopens the slot
(removes the member from `event_attendees`), and a replacement is then invited
through the EXISTING member-directory invite flow (`POST /api/invitations`,
#37/#38/#41). Do not add a replacement endpoint here (that is where Phase 4 AI
suggestions later layer on). No code needed for this AC beyond the withdraw
path.

## Why no RPC (unlike accept/removal)

`accept_invitation` and `remove_church_group_member` are SECURITY DEFINER RPCs
because a plain `member` cannot write the tables they touch under RLS. Here the
caller is always set_leader/admin, who CAN write `invitations`,
`event_attendees`, `conflicts`, and `notifications` directly under existing RLS
(confirmed above). `withdrawInvitation` (#43) sets the precedent of doing this
in a plain handler. Keep it a handler; do not add a migration.

---

## Edge cases the implementation must handle

1. Non-existent conflict id, or a conflict in another church group → 404 (never
   403, never leak existence).
2. Already-resolved conflict (`resolved_at` set) → 409, no side effects
   (idempotency).
3. Invalid / missing `resolution` value in body → 400 VALIDATION_FAILED.
4. Caller is a plain `member` (or unauthenticated) → 403 (via `requireRole`) /
   401 (via `requireAuth`). GET has the same role gate.
5. Missing Supabase JWT → 401 UNAUTHENTICATED (same as sibling handlers).
6. Withdraw path where the invitation's service week has no `events` rows →
   the `event_attendees` delete is a no-op (skip when eventIds is empty); still
   succeed.
7. Withdraw path where the invitation is already `withdrawn`/`denied` (stale
   conflict): do NOT 409 on invitation status — proceed to remove any
   `event_attendees` and mark the conflict resolved (idempotent cleanup). Only
   the conflict's own `resolved_at` guards re-resolution (case 2).
8. `member_reconfirmed` / `admin_dismissed`: must NOT alter `invitations` or
   `event_attendees` at all — only set `resolution_type` + `resolved_at`.
9. GET returns `{ conflicts: [] }` (200) when there are no open conflicts.
10. Any DB `.error` on any query → 500 INTERNAL (never a partial-success 200).

---

## Verification (Coder must run before finishing)

- `bun run lint`
- `bun run typecheck`
- `bun run test`

## Tests (guidance for the Testing stage)

Model on `tests/unit/app/api/invitations-withdraw-route.test.ts` (mock
`@clerk/nextjs/server` + `@/lib/supabase/client`, `makeReq`/`makeLookup`/
`setUpAuth`, chainable Supabase mock). Cover, at minimum:
- GET: happy path returns open conflicts joined with member/week; role gate
  (member → 403); empty list.
- resolve `withdraw`: invitation flipped to `withdrawn`, `event_attendees`
  delete issued, member notified, `resolution_type='withdrawn'` + `resolved_at`
  set.
- resolve `member_reconfirmed` and `admin_dismissed`: conflict resolved with
  correct `resolution_type`, NO invitation/attendee writes.
- Failure cases: unknown id → 404; already-resolved → 409; bad body → 400.
