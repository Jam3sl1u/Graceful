# Spec — Issue #60: Event attendee assignment

## OPEN QUESTIONS
None. Definition of "confirmed member" and duplicate-assign behavior are
resolved in Decisions below from existing repo patterns.

## Summary
Implement the two attendee endpoints on the existing `event_attendees` join
table. Only members with an **accepted invitation for the event's service
week** may be assigned. Both endpoints are set_leader/admin only.

Currently both route files are 501 stubs (`notImplemented`). Everything else
(DB table, RLS policies, Supabase types) already exists — this is pure handler
work plus one Zod schema.

Out of scope for this issue (belongs to #62): notifying the assigned member and
Google Calendar sync. Do NOT write notification or GCal code. The AC line about
notify/sync is explicitly "depends on #62".

## Decisions (not ambiguities)
- **"Confirmed member"** = a row in `invitations` with
  `status = 'accepted'`, `user_id = <target>`, and
  `service_week_id = <event.service_week_id>`, in the caller's church group.
  Pending/denied/withdrawn/expired invitees are NOT confirmed (`invitation_status`
  enum values, see `lib/invitations/state-machine.ts`).
- **Duplicate assign** → `409 CONFLICT` (the table has `unique (event_id,
  user_id)`). Check for an existing attendee row first and return 409 rather
  than relying on the DB unique-violation error.
- **Cross-tenant / missing event** → `404 NOT_FOUND` (mirror
  `app/api/events/[id]/handler.ts`: load the event scoped by
  `church_group_id` and 404 when absent). This must be checked BEFORE the
  confirmed-member check so a foreign event never leaks its state.
- RLS on `event_attendees` only enforces tenant scoping (see
  `20260704000001_rls_policies.sql` lines 295-343) — it does NOT enforce the
  confirmed-member rule. That business rule lives entirely in the handler.

## Files to create

### 1. `app/api/events/[id]/attendees/handler.ts` (NEW)
Copy the structure/error-handling idiom from
`app/api/events/[id]/handler.ts` (same auth → jwt → supabase → guard flow,
same `try/catch` with `ApiException` mapping).

Exports:

```ts
export type AttendeeResponse = {
  id: string;
  eventId: string;
  userId: string;
  createdAt: string;
};

export function toAttendeeResponse(
  row: Database["public"]["Tables"]["event_attendees"]["Row"],
): AttendeeResponse;

// POST /api/events/:id/attendees — set_leader/admin only.
export async function assignAttendee(
  req: NextRequest,
  eventId: string,
  lookup?: UserLookup,
): Promise<Response>;

// DELETE /api/events/:id/attendees/:userId — set_leader/admin only.
export async function removeAttendee(
  req: NextRequest,
  eventId: string,
  targetUserId: string,
  lookup?: UserLookup,
): Promise<Response>;
```

Imports needed (same as sibling handler): `NextRequest`, `auth` from
`@clerk/nextjs/server`, `requireAuth`/`requireRole`/`UserLookup` from
`@/lib/api/auth`, `ok`/`fail` from `@/lib/api/response`, `ApiException`/
`ErrorCode` from `@/lib/api/errors`, `getSupabaseClient` from
`@/lib/supabase/client`, `Database` type from `@/lib/supabase/types`,
`assignAttendeeSchema` from `@/schemas/events`.

`assignAttendee` flow:
1. `ctx = await requireAuth(req, lookup)`; `requireRole(ctx, ["admin", "set_leader"])`.
2. Parse body with `assignAttendeeSchema.safeParse(await req.json().catch(() => null))`
   → on failure `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
3. Get supabase JWT client (same `getToken({ template: "supabase" })` idiom;
   missing jwt → 401 UNAUTHENTICATED).
4. Load event: `.from("events").select("service_week_id")
   .eq("id", eventId).eq("church_group_id", ctx.churchGroupId).maybeSingle()`.
   DB error → 500 INTERNAL; no row → 404 NOT_FOUND.
5. Confirmed-member check: `.from("invitations").select("id")
   .eq("church_group_id", ctx.churchGroupId)
   .eq("service_week_id", event.service_week_id)
   .eq("user_id", parsed.userId).eq("status", "accepted").maybeSingle()`.
   DB error → 500; no row → `fail("Member is not confirmed for this event",
   ErrorCode.VALIDATION_FAILED, 422)`.
6. Duplicate check: `.from("event_attendees").select("id")
   .eq("event_id", eventId).eq("user_id", parsed.userId).maybeSingle()`.
   If a row exists → `fail("Member is already assigned to this event",
   ErrorCode.CONFLICT, 409)`.
7. Insert: `.from("event_attendees").insert({ event_id: eventId,
   user_id: parsed.userId }).select("*").maybeSingle()`. Insert payload needs
   only `event_id`/`user_id` (Insert type makes `id`/`created_at` optional — no
   cast needed). Error or no row → 500 INTERNAL.
8. `return ok({ attendee: toAttendeeResponse(row) }, 201)`.

`removeAttendee` flow:
1. `requireAuth` + `requireRole(ctx, ["admin", "set_leader"])`.
2. Supabase JWT client (missing jwt → 401).
3. Load event scoped by `church_group_id` (`select("id")...maybeSingle()`);
   no row → 404 NOT_FOUND (prevents cross-tenant delete probing).
4. Delete: `.from("event_attendees").delete().eq("event_id", eventId)
   .eq("user_id", targetUserId).select("id").maybeSingle()`.
   DB error → 500. No row deleted → 404 NOT_FOUND (member wasn't assigned).
5. `return ok({ deleted: true })`.

Wrap both in `try/catch` mapping `ApiException` → `fail(err.message, err.code,
err.status)`, else `fail("Internal error", ErrorCode.INTERNAL, 500)` — exactly
as in the sibling handler.

## Files to modify

### 2. `app/api/events/[id]/attendees/route.ts` (REPLACE stub)
Follow `app/api/events/[id]/route.ts` wiring:
```ts
import { NextRequest } from "next/server";
import { assignAttendee } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return assignAttendee(req, id);
}
```

### 3. `app/api/events/[id]/attendees/[userId]/route.ts` (REPLACE stub)
```ts
import { NextRequest } from "next/server";
import { removeAttendee } from "../handler";

type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id, userId } = await params;
  return removeAttendee(req, id, userId);
}
```

### 4. `schemas/events.ts` (ADD schema)
Append (same Zod style as `createEventSchema`):
```ts
// POST /api/events/:id/attendees body.
export const assignAttendeeSchema = z.object({
  userId: z.string().uuid(),
});
export type AssignAttendeeInput = z.infer<typeof assignAttendeeSchema>;
```

## Edge cases the implementation must handle
- Unauthenticated / no Clerk user → 401 (via `requireAuth`).
- Missing supabase JWT → 401 UNAUTHENTICATED.
- Caller role `member`/`guest` → 403 FORBIDDEN (via `requireRole`).
- Event not found or in another church group → 404 NOT_FOUND (both endpoints).
- POST body not `{ userId: <uuid> }` (missing/empty/non-uuid) → 400
  VALIDATION_FAILED.
- Target user with no invitation, or invitation status pending/denied/
  withdrawn/expired for this event's week → 422 VALIDATION_FAILED.
- Target already assigned → 409 CONFLICT.
- DELETE for a user who isn't currently assigned → 404 NOT_FOUND.
- All Supabase `.error` branches → 500 INTERNAL.

## Verification
Run `bun run lint`, `bun run typecheck`, `bun run test` before finishing.

## Test guidance (for the tester stage)
Unit-test the handlers with the mock pattern in
`tests/unit/app/api/events-id-route.test.ts` (jest.mock of
`@clerk/nextjs/server` and `@/lib/supabase/client`, `makeChain` table-fixture
harness keyed by table name, `makeLookup(role)` for auth context). Cover:
happy-path assign (201) & remove (deleted:true); confirmed-member rejection
(422); non-leader 403; missing event 404; duplicate assign 409;
delete-not-assigned 404.
