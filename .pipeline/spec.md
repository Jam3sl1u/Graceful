# Spec — Issue #43: Withdraw invitation (`DELETE /api/invitations/:id`)

## OPEN QUESTIONS

None. Two product decisions the issue left open were resolvable from the issue
text + existing code conventions (documented under "Decisions" below), and the
reminder-cancellation AC is explicitly a downstream dependency (#45) that is not
buildable yet. Nothing is blocking.

## Summary

Implement `DELETE /api/invitations/:id` so a Set Leader/Admin can withdraw a
**pending** invitation: flip its status to `withdrawn`, notify the invited
member in-app, and write an audit log. This mirrors the existing
`denyInvitation` handler almost exactly (same file, same client, same
audit/notify plumbing) — it does **not** need a new SECURITY DEFINER RPC,
because the actor is a leader/admin whose RLS-scoped client is already permitted
to UPDATE any invitation in the group and INSERT a notification for another user
(see RLS analysis below).

## Decisions (resolved, not open questions)

1. **Non-pending invitations are rejected with `409 CONFLICT`**, not handled
   idempotently. The issue says withdrawing an already-accepted/denied
   invitation "should be rejected or redirected to the appropriate flow." An
   accepted invitation has `event_attendees` side-effects that a plain status
   flip would not unwind, so a clean withdraw is only correct while `pending`.
   Applies to `accepted`, `denied`, `withdrawn`, and `expired` alike (any
   status other than `pending` → 409). This deliberately differs from
   `denyInvitation`'s idempotent-200 behavior.
2. **A new `invitation_withdrawn` notification type is added.** No existing
   `notification_type` enum value fits "your invitation was withdrawn"
   (`set_invitation` is the original invite). Follows the precedent set by
   `supabase/migrations/20260711000001_service_week_notification_types.sql`
   (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`).
3. **AC "Cancels any pending 24h reminders" is deferred to #45.** The only
   hook, `cancelReminder` in `lib/upstash/qstash.ts`, is a stub that throws
   ("not implemented — see Sprint 2 #36"). Calling it now would break the
   handler. Leave a `TODO(#45/#36)` comment at the withdraw point (mirrors the
   `TODO(#67/#68)` dispatch comments already in `handler.ts`). Do NOT import or
   call `cancelReminder`.

## Files to create / modify

### 1. `supabase/migrations/20260712000002_invitation_withdrawn_notification_type.sql` (CREATE)
New migration adding the enum value. Copy the shape of
`supabase/migrations/20260711000001_service_week_notification_types.sql`
verbatim (header comment referencing #43, `-- ============ UP ============`,
the `ALTER TYPE`, and a commented DOWN explaining Postgres can't drop enum
values). Body:

```sql
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'invitation_withdrawn';
```

Note the timestamp prefix `20260712000002` — it must sort AFTER the existing
`20260712000001_accept_invitation_rpc.sql`.

### 2. `types/domain.ts` (MODIFY)
Add `"invitation_withdrawn"` to the `NotificationType` union (line ~22–35).
Place it right after `"invitation_denied"` to keep the invitation-family values
grouped. No other type in this file changes. `lib/supabase/types.ts` needs NO
change — its `NotificationsRow.type` already references this `NotificationType`
alias.

### 3. `app/api/invitations/handler.ts` (MODIFY)
Add a new exported async function `withdrawInvitation`, placed after
`denyInvitation`. Signature (mirror `denyInvitation`):

```ts
export async function withdrawInvitation(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>
```

Behavior, in order:
1. `const ctx = await requireAuth(req, lookup);`
2. `requireRole(ctx, ["admin", "set_leader"]);` — this is the "Set Leader/Admin
   only" gate. `requireRole` throws `ApiException(FORBIDDEN, 403)`, caught by
   the existing `catch`.
3. Get the Supabase JWT exactly as `denyInvitation` does; 401 if no JWT.
   `const supabase = getSupabaseClient(jwt);`
4. Fetch the invitation scoped by **`church_group_id` only** (NOT `user_id` —
   the leader is withdrawing someone else's invitation):
   `.from("invitations").select("*").eq("id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`.
   On query error → 500 INTERNAL. On `!inv` → 404 NOT_FOUND (missing /
   wrong-group indistinguishable, per the repo's 404-not-403 convention).
5. If `inv.status !== "pending"` → `fail("Invitation is not pending", ErrorCode.CONFLICT, 409)`
   (Decision 1). No update, no notification, no audit.
6. Update the row:
   ```ts
   const patch: Database["public"]["Tables"]["invitations"]["Update"] = {
     status: "withdrawn",
   };
   ```
   `.update(patch).eq("id", id).eq("church_group_id", ctx.churchGroupId).select("*").maybeSingle()`.
   On error → 500. On `!updated` → 404.
   (Do NOT set `responded_at` — withdrawal is a leader action, not a member
   response. `denial`/`accept` set `responded_at` because the member responded;
   withdrawal did not.)
7. Insert the member notification (member = `inv.user_id`):
   ```ts
   const { error: notifyError } = await supabase.from("notifications").insert({
     church_group_id: inv.church_group_id,
     user_id: inv.user_id,
     type: "invitation_withdrawn",
     title: "Invitation withdrawn",
     body: "Your set invitation was withdrawn",
     link_entity_type: "invitation",
     link_entity_id: inv.id,
   } as Database["public"]["Tables"]["notifications"]["Insert"]);
   ```
   If `notifyError` → 500 INTERNAL (do not swallow; the notification is an
   acceptance criterion). Follow the column set used by the `notifications`
   insert inside `supabase/migrations/20260712000001_accept_invitation_rpc.sql`.
8. Write the audit log via the existing helper:
   ```ts
   await writeAuditLog(supabase, {
     action: "invitation.withdrawn",
     entityType: "invitation",
     entityId: id,
     metadata: {
       service_week_id: inv.service_week_id,
       user_id: inv.user_id,
     },
   });
   ```
9. `// TODO(#45/#36): cancel any pending 24h reminders for this invitation.`
10. Return `ok({ invitation: toInvitationResponse(updated) });`
11. Wrap the whole body in the same `try/catch` as `denyInvitation`
    (`ApiException` → `fail(err.message, err.code, err.status)`, else 500).

Reuse existing imports already in the file (`requireAuth`, `requireRole`,
`ok`, `fail`, `ApiException`, `ErrorCode`, `getSupabaseClient`, `writeAuditLog`,
`toInvitationResponse`, `Database`). No new imports needed.

### 4. `app/api/invitations/[id]/route.ts` (MODIFY — replace the stub)
Currently returns `notImplemented`. Replace with the wiring pattern used by
`app/api/invitations/[id]/deny/route.ts`:

```ts
import { NextRequest } from "next/server";
import { withdrawInvitation } from "../../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return withdrawInvitation(req, id);
}
```

Drop the now-unused `notImplemented` import.

### 5. `tests/unit/app/api/invitations-withdraw-route.test.ts` (CREATE)
The Coder should add this so `changes.md` reflects it; the Tester owns
independent verification. Copy the entire mock scaffolding
(`jest.mock` of `@clerk/nextjs/server` + `@/lib/supabase/client`, `makeReq`,
`makeLookup`, `setUpAuth`, `makeChain`, `makeSupabaseClient`,
`pendingInvitationRow`) from `tests/unit/app/api/invitations-deny-route.test.ts`.
Cases (see Edge cases):
- 403 FORBIDDEN when caller role is `member`.
- 401 when no JWT.
- 404 when invitation not found (null select).
- 409 CONFLICT when status is `accepted` (and a second case for `denied`).
- Happy path: `pending` → update payload `{ status: "withdrawn" }`, a
  `notifications` insert targeting `inv.user_id` with `type:
  "invitation_withdrawn"`, and a `write_audit_log` RPC call with action
  `invitation.withdrawn`. Assert `responded_at` is NOT set on the update
  payload.
- 500 when the invitation lookup query errors.

## Edge cases the implementation must handle

- **Role gate:** `member`/`guest` caller → 403 FORBIDDEN (via `requireRole`).
- **Wrong group / missing id:** → 404 NOT_FOUND, never 403 (do not leak
  cross-tenant existence). Achieved by the `church_group_id` filter + 404 on
  empty.
- **Non-pending status** (`accepted`, `denied`, `withdrawn`, `expired`) → 409
  CONFLICT, no side effects.
- **No JWT** from `getToken` → 401 UNAUTHENTICATED (before touching the DB).
- **DB errors** on select / update / notification insert / audit RPC → 500
  INTERNAL (none swallowed).
- **Notification target is the member, not the actor:** `user_id = inv.user_id`
  (the invited member), inserted by the leader/admin's RLS client.

## RLS / "no RPC needed" rationale (for the Coder's confidence)

From `supabase/migrations/20260704000001_rls_policies.sql`:
- `invitations_update_leader_admin` lets a leader/admin UPDATE any invitation in
  their group.
- `notifications_insert_leader_admin` lets a leader/admin INSERT a notification
  for ANY user in the group (WITH CHECK only requires group match + leader/admin
  role, not `user_id = auth_user_id()`).
- `write_audit_log` RPC already works for an authenticated leader/admin.
This is why `acceptInvitation` needed a SECURITY DEFINER RPC (a *member* can't
write notifications/audit rows) but `withdrawInvitation` does not.

## "Slot reopens" note

For a `pending` invitation there are no `event_attendees` rows yet (those are
inserted only at accept time, per the `accept_invitation` RPC). So "the slot
reopens" is satisfied by the status flip alone — there is nothing to delete from
`event_attendees`. Do NOT add event_attendees cleanup.

## Out of scope (do not implement)

- Bulk withdrawal of multiple invitations.
- Any reminder scheduling/cancellation wiring (deferred to #45/#36 — comment
  only).
- Withdrawing accepted invitations / unwinding `event_attendees`.

## Verify before finishing

`bun run lint`, `bun run typecheck`, `bun run test`.
