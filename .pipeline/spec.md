# Spec: Issue #40 — Send set invitation (POST /api/invitations, BR-05 double-booking check)

## OPEN QUESTIONS

None are blocking. Two design decisions are made below with defaults; proceed with them unless a human overrides.

1. **BR-05 "warning, admin can proceed or cancel" is a two-step API contract.** This issue is the
   API, not the UI. Implemented as: without an `acknowledgeConflict: true` flag in the request body,
   a detected double-booking short-circuits and returns **409 CONFLICT** with the conflicting week
   details so the client can prompt "proceed or cancel". With `acknowledgeConflict: true`, the
   invitation is created despite the warning. This is the standard way to express "warn, then
   allow override" over a stateless HTTP POST and matches the AC ("shows a warning, but admin can
   proceed or cancel").

2. **`response_token` format.** DB column is `response_token varchar(64) not null unique`. Generate
   a 64-char hex token in the handler using the Node `crypto` global (available in Next.js route
   handlers): `crypto.randomBytes(32).toString("hex")`. Import `randomBytes` from `node:crypto`.

## Current state (already done — do NOT redo)

- DB schema is complete. `supabase/migrations/20260702000003_cluster_3_scheduling_core.sql` already
  defines the `invitations` table with ALL needed columns: `id, church_group_id, service_week_id,
  user_id, role_note, status (default 'pending'), response_token (varchar(64) unique), responded_at,
  denial_reason, denial_count, response_deadline, invited_by, created_at`. The `conflicts` table also
  already exists. **No new migration is needed.**
- RLS is complete (`supabase/migrations/20260704000001_rls_policies.sql`): `invitations_insert_leader_admin`
  and `conflicts_insert_leader_admin` already gate INSERTs to leader/admin in the same group. The
  `write_audit_log` RPC exists and is used via `lib/audit/write-audit-log.ts`.

## What this issue implements

`POST /api/invitations` only. GET is out of scope for #40 — leave the `GET` export in
`app/api/invitations/route.ts` as the existing `notImplemented` stub. Accept/deny/withdraw/token-lookup
are separate issues (#41–#45) — do not touch those routes.

The `conflicts` INSERT ("conflict flag raised when member accepts both") happens at **accept** time
(#41), NOT here. This issue only performs the *check* and records the warning. Do NOT write a
`conflicts` row in this handler.

## Files to modify

### 1. `lib/supabase/types.ts` — fix the incomplete `InvitationsRow`

The hand-rolled `InvitationsRow` (around line 94) is missing columns the DB actually has. Replace it so
it matches the migration. New shape:

```ts
type InvitationsRow = {
  id: string;
  church_group_id: string;
  service_week_id: string;
  user_id: string;
  role_note: string | null;
  status: InvitationStatus;
  response_token: string;
  responded_at: string | null;
  denial_reason: string | null;
  denial_count: number;
  response_deadline: string | null;
  invited_by: string | null;
  created_at: string;
};
```

Then update the `invitations` table entry in the `Database` type (around line 178) so `Insert` omits
the DB-defaulted / server-generated columns, mirroring how `service_weeks` does it (see lines 152–161):

```ts
invitations: {
  Row: InvitationsRow;
  Insert: Omit<
    InvitationsRow,
    "id" | "created_at" | "status" | "responded_at" | "denial_reason" | "denial_count" | "response_deadline"
  > & {
    id?: string;
    created_at?: string;
    status?: InvitationStatus;
    responded_at?: string | null;
    denial_reason?: string | null;
    denial_count?: number;
    response_deadline?: string | null;
  };
  Update: Partial<InvitationsRow>;
  Relationships: [];
};
```

`InvitationStatus` is already imported at the top of the file (line 9).

### 2. `schemas/invitations.ts` — real create schema

The file currently holds only an empty placeholder `invitationsSchema = z.object({})`. Add the create
schema (keep the existing `invitationsSchema`/`InvitationsInput` export in place — other stubs may
reference it). Follow the style of `schemas/service-weeks.ts`.

```ts
export const createInvitationSchema = z.object({
  serviceWeekId: z.string().uuid(),
  userId: z.string().uuid(),
  roleNote: z.string().trim().min(1).max(500).optional(),
  acknowledgeConflict: z.boolean().optional(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
```

`roleNote` is optional (DB column `role_note` is nullable). `acknowledgeConflict` defaults to
undefined/false (the BR-05 override flag).

### 3. `app/api/invitations/handler.ts` — NEW FILE (handler layer)

Follow the exact structure of `app/api/service-weeks/handler.ts` and
`app/api/church-group/members/[id]/role/handler.ts` (the latter for the `writeAuditLog` usage).

Export a response mapper and a `createInvitation` function:

```ts
export type InvitationResponse = {
  id: string;
  serviceWeekId: string;
  userId: string;
  roleNote: string | null;
  status: InvitationStatus;
  responseToken: string;
  responseDeadline: string | null;
  invitedBy: string | null;
  createdAt: string;
};

export function toInvitationResponse(row: InvitationsRow): InvitationResponse;

export async function createInvitation(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

`createInvitation` logic, in order:

1. `const ctx = await requireAuth(req, lookup);`
2. `requireRole(ctx, ["admin", "set_leader"]);` (Set Leaders send invitations; app-layer check even
   though RLS also gates it — mirror the role/handler.ts comment rationale).
3. Parse body with `createInvitationSchema.safeParse`; on failure return
   `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`. Handle non-JSON body via
   `req.json().catch(() => null)` (same as service-weeks).
4. Get the supabase JWT client exactly as service-weeks does (401 UNAUTHENTICATED if no JWT).
5. **Validate the target service week exists in the caller's group.** Query `service_weeks` by
   `id = serviceWeekId` and `church_group_id = ctx.churchGroupId`, `.maybeSingle()`. If DB error →
   500 INTERNAL. If not found → `fail("Service week not found", ErrorCode.NOT_FOUND, 404)`. Keep the
   `service_date` from this row for the BR-05 check.
6. **BR-05 double-booking check.** Query for OTHER invitations that would collide on the same calendar
   date with `status = 'accepted'`:
   - Select `invitations` joined to `service_weeks` on the same `church_group_id` where
     `invitations.user_id = userId`, `invitations.status = 'accepted'`, the joined
     `service_weeks.service_date = <this week's service_date>`, and
     `invitations.service_week_id <> serviceWeekId` (exclude the current week).
   - Implementation approach (no cross-table join helper exists; do two queries): first select the
     accepted invitations for this user in this group (`.eq("user_id", userId).eq("status",
     "accepted").eq("church_group_id", ctx.churchGroupId)` selecting `service_week_id`), then select
     `service_weeks` whose `id in (...those week ids)` AND `service_date = thisDate` AND `id <>
     serviceWeekId`. A non-empty result = a double-booking on that date.
   - On DB error in either query → 500 INTERNAL.
   - If a collision is found AND `acknowledgeConflict !== true`: return
     `fail("Member already confirmed for another week on this date", ErrorCode.CONFLICT, 409)` — the
     response body's `error`/`code` follow the standard `fail` shape (there is no custom detail
     envelope; `fail` only takes message+code+status). The client re-POSTs with
     `acknowledgeConflict: true` to override.
   - If a collision is found AND `acknowledgeConflict === true`: proceed (do not block).
   - If no collision: proceed.
7. **Insert the invitation.** Generate `response_token` = `randomBytes(32).toString("hex")` and
   `response_deadline` = now + 72 hours as ISO string: `new Date(Date.now() + 72 * 60 * 60 *
   1000).toISOString()`. Build the insert payload (cast narrowly with
   `as unknown as Database["public"]["Tables"]["invitations"]["Insert"]`, mirroring service-weeks
   line 124–132, because the hand-rolled Insert type still marks some columns required):
   ```ts
   {
     church_group_id: ctx.churchGroupId,
     service_week_id: parsed.serviceWeekId,
     user_id: parsed.userId,
     role_note: parsed.roleNote ?? null,
     response_token: token,
     response_deadline: deadlineIso,
     invited_by: ctx.userId,
   }
   ```
   Do NOT set `status` (DB defaults to `'pending'`). `.insert(payload).select("*").maybeSingle()`.
   On error or null row → 500 INTERNAL.
8. **Audit log.** `await writeAuditLog(supabase, { action: "invitation.sent", entityType:
   "invitation", entityId: invitation.id, metadata: { service_week_id: parsed.serviceWeekId, user_id:
   parsed.userId, acknowledged_conflict: parsed.acknowledgeConflict === true } });`
9. **Notification stub.** SMS/email dispatch is #67/#68 and explicitly out of scope. Do NOT call any
   notification service. Add a single comment marking the seam, e.g.
   `// TODO(#67/#68): dispatch SMS/email invitation notification here.` Do not create a stub module.
10. Return `ok({ invitation: toInvitationResponse(invitation) }, 201)`.
11. Wrap the whole body in the same `try/catch` as service-weeks: `if (err instanceof ApiException)
    return fail(err.message, err.code, err.status); return fail("Internal error", ErrorCode.INTERNAL,
    500);`

### 4. `app/api/invitations/route.ts` — wire POST to the handler

Currently both GET and POST are `notImplemented` stubs. Change **only POST** to delegate, matching
`app/api/service-weeks/route.ts`:

```ts
import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";
import { createInvitation } from "./handler";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/invitations");
}

export async function POST(req: NextRequest): Promise<Response> {
  return createInvitation(req);
}
```

## Edge cases the implementation MUST handle

- No Clerk user / no Supabase JWT → 401 UNAUTHENTICATED (JWT check happens before any DB work).
- `member` or `guest` caller → 403 FORBIDDEN, before any DB work (requireRole throws).
- Malformed/non-JSON body, missing `serviceWeekId`/`userId`, non-uuid ids, `roleNote` empty/whitespace
  or > 500 chars → 400 VALIDATION_FAILED.
- `serviceWeekId` points to a week in another group or a non-existent week → 404 NOT_FOUND (RLS + the
  explicit `church_group_id` filter make wrong-group and missing indistinguishable; always 404, never
  403 — mirror the role/handler.ts comment).
- Double-booking found without `acknowledgeConflict` → 409 CONFLICT (invitation NOT created).
- Double-booking found WITH `acknowledgeConflict: true` → invitation created (201).
- No double-booking → invitation created (201).
- Any Supabase query/insert error → 500 INTERNAL. `writeAuditLog` throwing ApiException is caught by
  the outer try/catch and surfaces as 500.
- The BR-05 query must only count `status = 'accepted'` invitations and must exclude the current
  `serviceWeekId` (selecting the same person for the same week is not a double-booking).

## Tests to add

Create `tests/unit/app/api/invitations-route.test.ts`. Copy the mock scaffolding wholesale from
`tests/unit/app/api/service-weeks-route.test.ts` (same `makeChain` / `makeSupabaseClient` /
`setUpAuth` / `makeLookup` helpers, same `onInsert` hook to capture payloads). Cover:

- 401 when Clerk userId null (lookup not consulted) and when getToken yields no JWT.
- 403 for `member` and `guest` (before DB work).
- 400 for: non-JSON body, missing `serviceWeekId`, missing `userId`, non-uuid `userId`, `roleNote`
  too long.
- 404 when the service week is not found.
- 201 happy path with no double-booking: asserts status default is NOT set in the insert payload,
  asserts `response_token` (64 hex chars) and `response_deadline` (~72h out) are present in the
  payload, asserts `invited_by === USER_ID`, asserts `writeAuditLog`/`rpc("write_audit_log", ...)` was
  invoked with `action: "invitation.sent"`.
- 409 CONFLICT when a double-booking exists and `acknowledgeConflict` is absent (assert NO invitation
  insert occurred).
- 201 when the same double-booking exists but `acknowledgeConflict: true` (assert the insert DID
  occur).
- 500 when the invitation insert errors.

Note the BR-05 check issues extra `invitations` and `service_weeks` SELECTs beyond what the
service-weeks fixtures cover — extend the fixture defaults so those queries resolve, and add
per-test overrides to simulate the "accepted invitation on the same date" collision. `writeAuditLog`
calls `supabase.rpc("write_audit_log", ...)`, so the mock client needs an `rpc` method returning
`{ error: null }` (add it to `makeSupabaseClient`).

## Patterns to follow (named references)

- Handler shape, JWT retrieval, `try/catch`, narrow Insert cast: `app/api/service-weeks/handler.ts`.
- `writeAuditLog` usage + 404-not-403 rationale: `app/api/church-group/members/[id]/role/handler.ts`.
- Route → handler delegation: `app/api/service-weeks/route.ts`.
- Zod schema style: `schemas/service-weeks.ts`.
- Unit-test mock scaffolding: `tests/unit/app/api/service-weeks-route.test.ts`.

## Out of scope (do NOT implement)

- SMS/email dispatch (#67/#68) — comment seam only.
- Writing to the `conflicts` table (that happens at accept time, #41).
- GET/accept/deny/withdraw/token-lookup routes (#41–#45).
- Any new DB migration or RLS change (schema already supports everything here).
- The `expired` status (domain.ts lists it but the DB enum does not include it; irrelevant to this
  issue — do not touch the enum).
