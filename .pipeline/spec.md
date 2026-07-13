# Spec: Issue #42 — Deny invitation with reason (POST /api/invitations/:id/deny, BR-08 denial cap)

## OPEN QUESTIONS

None are blocking. Design decisions made below (proceed with these unless a human overrides):

1. **Who may deny.** PRD §22 lists this endpoint's role as "Member / Guest" and §6.3 frames it as
   the *invited* member responding to their *own* invitation (in-app path, PRD "In-app response").
   Decision: any authenticated user may call it, but the query is scoped to the caller's own
   invitation (`user_id = ctx.userId`). A non-owner (including a set_leader/admin acting on someone
   else's invitation) simply matches no row → **404 NOT_FOUND**, matching this repo's existing
   "never leak existence, always 404" convention (see `app/api/service-weeks/[id]/handler.ts`).
   No `requireRole` call — an invited admin can deny "as any member would" (PRD §11).

2. **Notification dispatch is deferred.** AC says admin gets SMS + email "once #67/#68 exist"; they
   do not exist yet. Mirror the precedent set by `createInvitation` (issue #40), which left this as
   a `TODO(#67/#68)` comment and created **no** notification row. This issue does the same: audit
   log is written, actual SMS/email/in-app fan-out is a `TODO(#67/#68)`. Do not invent a
   notification insert.

3. **"Slot reopens" requires no new code.** There is no `slots` table; roster/slot status is derived
   from the `invitations` rows (a denied invitation no longer holds the slot). Setting
   `status = 'denied'` fully satisfies "slot reopens." Likewise "no event_attendees or calendar
   entries created on denial" is satisfied by simply not creating any — there is nothing to delete.

## Current state (already in place — do NOT recreate)

- `app/api/invitations/[id]/deny/route.ts` exists but is a `notImplemented("...")` stub.
- `app/api/invitations/handler.ts` already implements `createInvitation` and exports
  `toInvitationResponse(row)` + the `InvitationResponse` type — reuse both.
- DB columns already exist (migration `20260702000003_cluster_3_scheduling_core.sql`):
  `invitations.status`, `denial_reason text`, `denial_count integer not null default 0`,
  `responded_at timestamptz`. The Update type `Database["public"]["Tables"]["invitations"]["Update"]`
  is `Partial<InvitationsRow>`, so all these fields are assignable.
- `InvitationStatus` union (`types/domain.ts`) already includes `"denied"`.
- `schemas/invitations.ts` already has `createInvitationSchema`; add the new deny schema alongside it.

## Files to change

### 1. `schemas/invitations.ts` — add deny body schema

Add (follow the style/comments of `createInvitationSchema` in the same file):

```ts
// POST /api/invitations/:id/deny body (#42). reason is optional (max 200 chars,
// PRD §6.3 / BR-08). An absent body or empty/whitespace-only reason both mean
// "no reason" and are valid (NOT a 400) — the handler coerces them to null.
export const denyInvitationSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});
export type DenyInvitationInput = z.infer<typeof denyInvitationSchema>;
```

Note: do NOT use `.min(1)` — an empty reason must be accepted, not rejected.

### 2. `app/api/invitations/handler.ts` — add `denyInvitation`

Add a new exported function. Copy the structure of `createInvitation` (same imports, same
`try/catch` → `ApiException`/`fail` tail, same `auth()`→`getToken({template:"supabase"})`→
`getSupabaseClient(jwt)` sequence). Signature:

```ts
export async function denyInvitation(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>
```

Import `denyInvitationSchema` from `@/schemas/invitations`.

Logic, in order:

1. `const ctx = await requireAuth(req, lookup);` (NO `requireRole` — see OPEN QUESTION 1).
2. Parse body tolerantly:
   ```ts
   const body = await req.json().catch(() => null);
   const parsedResult = denyInvitationSchema.safeParse(body ?? {});
   if (!parsedResult.success) return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
   const rawReason = parsedResult.data.reason;
   const reason = rawReason && rawReason.length > 0 ? rawReason : null;
   ```
   (Passing `body ?? {}` makes a missing/empty POST body valid → reason `null`.)
3. Get jwt; if none → `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`. Build `supabase`.
4. Fetch the caller's own invitation:
   ```ts
   const { data: inv, error: invError } = await supabase
     .from("invitations")
     .select("*")
     .eq("id", id)
     .eq("church_group_id", ctx.churchGroupId)
     .eq("user_id", ctx.userId)
     .maybeSingle();
   ```
   - `invError` → `fail("Internal error", ErrorCode.INTERNAL, 500)`.
   - `!inv` → `fail("Not found", ErrorCode.NOT_FOUND, 404)`.
5. **Idempotency** (PRD §12 "link used after already responding → return current status, no side
   effects"): if `inv.status !== "pending"`, return `ok({ invitation: toInvitationResponse(inv) })`
   (200) with NO update, NO count change, NO audit write. Covers already-denied, already-accepted,
   withdrawn, and expired.
6. **BR-08 denial_count** (per-week, across invitation rows — see Implementation Notes on the issue:
   "increment on each new invitation+deny pair, not globally per member"): count prior denied
   invitations for this member+week, then this one is `+1`:
   ```ts
   const { data: priorDenied, error: priorError } = await supabase
     .from("invitations")
     .select("id")
     .eq("user_id", inv.user_id)
     .eq("service_week_id", inv.service_week_id)
     .eq("status", "denied");
   if (priorError) return fail("Internal error", ErrorCode.INTERNAL, 500);
   const denialCount = (priorDenied ?? []).length + 1;
   ```
7. Update this row to denied:
   ```ts
   const patch: Database["public"]["Tables"]["invitations"]["Update"] = {
     status: "denied",
     denial_reason: reason,
     denial_count: denialCount,
     responded_at: new Date().toISOString(),
   };
   const { data: updated, error: updateError } = await supabase
     .from("invitations")
     .update(patch)
     .eq("id", id)
     .eq("church_group_id", ctx.churchGroupId)
     .eq("user_id", ctx.userId)
     .select("*")
     .maybeSingle();
   ```
   - `updateError` → 500 INTERNAL. `!updated` → 404 NOT_FOUND.
8. Audit log (reuse `writeAuditLog`, mirror the `invitation.sent` call in `createInvitation`):
   ```ts
   await writeAuditLog(supabase, {
     action: "invitation.denied",
     entityType: "invitation",
     entityId: id,
     metadata: {
       service_week_id: inv.service_week_id,
       denial_count: denialCount,
       reason_provided: reason !== null,
     },
   });
   ```
   Do NOT put the raw reason text in the audit metadata.
9. `// TODO(#67/#68): dispatch SMS + email to invited_by (admin) with member name and reason.`
10. Return `ok({ invitation: toInvitationResponse(updated) })` (200).

### 3. `app/api/invitations/[id]/deny/route.ts` — wire the route

Replace the stub. Follow `app/api/service-weeks/[id]/cancel/route.ts` exactly:

```ts
import { NextRequest } from "next/server";
import { denyInvitation } from "../../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return denyInvitation(req, id);
}
```

(`../../handler` resolves from `app/api/invitations/[id]/deny/` to `app/api/invitations/handler.ts`.)

### 4. `app/api/invitations/handler.ts` — enforce the BR-08 cap on the SEND path

AC #3 requires that "after 3 denials for the same week, no further invites can be sent to that
member for that week." That enforcement belongs in `createInvitation` (the send path). Add a guard
**after** the service-week lookup (the `if (!week)` 404 block) and **before** the BR-05
double-booking check:

```ts
// BR-08 (PRD §8): a member who has denied 3 invitations for this service week
// cannot be re-invited for it.
const { data: deniedForWeek, error: deniedError } = await supabase
  .from("invitations")
  .select("id")
  .eq("user_id", parsed.userId)
  .eq("service_week_id", parsed.serviceWeekId)
  .eq("status", "denied");
if (deniedError) return fail("Internal error", ErrorCode.INTERNAL, 500);
if ((deniedForWeek ?? []).length >= 3) {
  return fail(
    "Member has denied 3 invitations for this week and cannot be re-invited (BR-08)",
    ErrorCode.CONFLICT,
    409,
  );
}
```

This is additive and must not alter any existing `createInvitation` behavior/branch above it.

## Edge cases the implementation must handle

- **No JSON / empty body** on deny → valid, `reason = null`, proceeds to deny.
- **`reason` > 200 chars** (after trim) → 400 VALIDATION_FAILED. **`reason` present but not a string**
  (e.g. `{ reason: 123 }`) → 400.
- **Empty / whitespace-only reason** → accepted, stored as `null` (NOT 400).
- **Unauthenticated** (no Clerk user, or no supabase JWT) → 401 UNAUTHENTICATED.
- **Invitation id not found, in another group, or belonging to another user** → 404 NOT_FOUND
  (indistinguishable by design; never 403, never leak existence).
- **Already responded** (`status` is `denied`/`accepted`/`withdrawn`/`expired`) → 200 with the
  current invitation, no side effects (no re-increment, no re-audit).
- **denial_count accumulation** — 1st ever denial for member+week → `denial_count = 1`; a later new
  invitation for the same member+week that is denied → `denial_count = 2`; then `3`. Count is derived
  from existing `status = 'denied'` rows for that member+week, NOT from the row's own default 0.
- **BR-08 cap on send** — the 4th send attempt (after 3 denials exist for member+week) → 409 CONFLICT
  from `createInvitation`. The 1st–3rd sends still succeed.
- **No `event_attendees` / calendar / `conflicts` rows** are created or touched on denial.

## Patterns to copy (name the file)

- Single-resource status mutation + audit + `try/catch` tail: `app/api/service-weeks/[id]/handler.ts`
  (`setServiceWeekCancelled`, `updateServiceWeek`).
- Handler skeleton, `auth()`→jwt→`getSupabaseClient`, `writeAuditLog` usage, `toInvitationResponse`:
  `app/api/invitations/handler.ts` (`createInvitation`).
- Route file with `params: Promise<{ id: string }>`: `app/api/service-weeks/[id]/cancel/route.ts`.
- Deny schema style: `createInvitationSchema` in `schemas/invitations.ts`.

## Tests

Add a unit test file `tests/unit/app/api/invitations-deny-route.test.ts`, copying the mock
scaffolding style of `tests/unit/app/api/invitations-route.test.ts` (the `makeReq`, `makeLookup`,
`setUpAuth`, `makeChain`/`makeSupabaseClient` helpers, and `jest.mock` of `@clerk/nextjs/server` +
`@/lib/supabase/client`). Cover at minimum: 401 (no JWT), 404 (not owner / not found), 400 (reason
too long), happy path pending→denied sets `status='denied'`/`denial_reason`/`denial_count=1` and
writes `invitation.denied` audit, empty-body deny (reason null), idempotent already-denied returns
200 with no update/audit, `denial_count` becomes 2 when one prior denied row exists, and the BR-08
send guard (`createInvitation` returns 409 when 3 denied rows already exist for member+week).

Verify with `bun run lint`, `bun run typecheck`, and `bun run test` before finishing.
