# Spec — Issue #41: Implement accept invitation flow

## OPEN QUESTIONS

None blocking. See "Deferred / explicitly out of scope" for one design tension
(BR-05 conflict-on-accept) that is intentionally NOT implemented here.

---

## Summary

Implement `POST /api/invitations/:id/accept`. It must work two ways:

1. **No-session** (SMS/email link): the request carries a `responseToken` in the
   body and there is no Clerk session.
2. **In-app** (authenticated member): no token; identity comes from the Clerk
   session.

Both paths converge on a single Postgres `SECURITY DEFINER` RPC that does all
validation and mutation atomically. This mirrors the existing pattern
(`record_availability_conflict`, `write_audit_log`) and is required because:

- The service-role key is banned in `app/`/`lib/` (`scripts/check-service-role.mjs`),
  so the no-session path has no JWT and must run as the `anon` role through a
  `SECURITY DEFINER` function that authenticates via the token itself.
- Acceptance must INSERT into `notifications` (admin notify), `event_attendees`,
  and `audit_logs` — none of which a plain `member` may write under RLS
  (`20260704000001_rls_policies.sql`): `notifications_insert_leader_admin` is
  leader/admin only, and `audit_logs` has no authenticated INSERT policy.

Doing the whole operation in one RPC keeps it atomic and satisfies "within 5
seconds" trivially.

---

## Current state (verified)

- `app/api/invitations/[id]/accept/route.ts` — stub returning `notImplemented`.
- `app/api/invitations/handler.ts` — exports `createInvitation`,
  `toInvitationResponse`, `InvitationResponse`. Add the accept handler here.
- `invitations` table (`20260702000003_cluster_3_scheduling_core.sql`) already
  has: `status invitation_status`, `response_token`, `responded_at`,
  `response_deadline`, `invited_by`, `created_at`, `service_week_id`, `user_id`,
  `church_group_id`. Enum `invitation_status` = `('pending','accepted','denied','withdrawn')`
  — there is **no** `'expired'` value in the DB, so expiry is computed, never stored.
- `events` and `event_attendees` tables exist (same migration). `event_attendees`
  columns: `id, event_id, user_id, created_at`, `unique (event_id, user_id)`. No
  `church_group_id` column. There are NO TypeScript types for `events`/`event_attendees`
  in `lib/supabase/types.ts` — do not add them; all event_attendees writes happen
  inside the RPC (SQL), not through the typed client.
- `notifications` table exists; `notification_type` enum already contains
  `'invitation_accepted'`. Insert shape used elsewhere: see
  `app/api/service-weeks/[id]/handler.ts` `setServiceWeekCancelled`.
- `getSupabaseClient(jwt)` (`lib/supabase/client.ts`) always sets an
  `Authorization: Bearer` header. There is **no** anon (no-JWT) client helper yet.
- `middleware.ts` — `/api/invitations/...` is NOT public; it is currently
  Clerk-protected. The no-session path requires this route be made public.

---

## Files to create / modify

### 1. NEW migration — `supabase/migrations/20260712000001_accept_invitation_rpc.sql`

Create `public.accept_invitation(p_invitation_id uuid, p_response_token text)`:

- `LANGUAGE plpgsql`, `SECURITY DEFINER`, `VOLATILE`, `SET search_path = ''`.
- `RETURNS jsonb`.
- `GRANT EXECUTE ... TO anon, authenticated;` (both roles — anon for the SMS
  link, authenticated for in-app).

Logic, in order:

1. `SELECT * INTO v_inv FROM public.invitations WHERE id = p_invitation_id`.
   If not found → `RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';`.
2. **Authorize:**
   - If `p_response_token IS NOT NULL`: require `p_response_token = v_inv.response_token`,
     else `RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';`. Acting user =
     `v_inv.user_id`. Set `v_via := 'token'`.
   - Else (session path): `v_clerk_id := auth.jwt() ->> 'sub'`. If null →
     `RAISE 'FORBIDDEN'`. Resolve `v_caller_id := (SELECT id FROM public.users WHERE clerk_id = v_clerk_id)`.
     Require `v_caller_id = v_inv.user_id` (member accepting their OWN invitation),
     else `RAISE 'FORBIDDEN'`. Set `v_via := 'session'`.
3. **Already responded (graceful, not an error):** if `v_inv.status <> 'pending'`,
   `RETURN jsonb_build_object('status', v_inv.status, 'already_responded', true, 'attendees_added', 0);`.
   (Covers accepted/denied/withdrawn — full edge UI is #51; here just don't error.)
4. **Expiry:** if `v_inv.response_deadline IS NOT NULL AND now() > v_inv.response_deadline`
   → `RAISE EXCEPTION 'EXPIRED' USING ERRCODE = 'P0001';`.
5. `UPDATE public.invitations SET status = 'accepted', responded_at = now() WHERE id = p_invitation_id;`.
6. **event_attendees** for every event of the week (idempotent; no-op when the
   week has no events yet — queued for #59/#60):
   ```sql
   INSERT INTO public.event_attendees (event_id, user_id)
   SELECT e.id, v_inv.user_id FROM public.events e
   WHERE e.service_week_id = v_inv.service_week_id
   ON CONFLICT (event_id, user_id) DO NOTHING;
   GET DIAGNOSTICS v_attendees_added = ROW_COUNT;
   ```
7. **Notify admin in-app.** Notify `v_inv.invited_by` if not null; if null, fall
   back to every `admin`/`set_leader` in `v_inv.church_group_id`. For each
   recipient INSERT a `notifications` row:
   `church_group_id = v_inv.church_group_id`, `user_id = <recipient>`,
   `type = 'invitation_accepted'`, `title = 'Invitation accepted'`,
   `body = <member name> || ' accepted their set invitation'`
   (member name = `SELECT name FROM public.users WHERE id = v_inv.user_id`),
   `link_entity_type = 'invitation'`, `link_entity_id = v_inv.id`.
8. **Audit log** (insert directly — this is the no-session-safe equivalent of
   `write_audit_log`, which cannot be used here because it derives identity from
   the JWT):
   ```sql
   INSERT INTO public.audit_logs (church_group_id, user_id, action, entity_type, entity_id, metadata)
   VALUES (v_inv.church_group_id, v_inv.user_id, 'invitation.accepted', 'invitation', v_inv.id,
     jsonb_build_object(
       'time_to_respond_seconds', floor(extract(epoch FROM (now() - v_inv.created_at)))::int,
       'via', v_via));
   ```
9. `RETURN jsonb_build_object('status', 'accepted', 'already_responded', false, 'attendees_added', v_attendees_added);`.

Add a `-- TODO(#62): Google Calendar sync on accept` comment (stubbed, not built).
Include a commented `-- ============ DOWN ============` with
`DROP FUNCTION IF EXISTS public.accept_invitation(uuid, text);` — follow the
header-comment style of `20260711000001_availability_conflict_rpc.sql`.

### 2. `lib/supabase/client.ts` — add anon client helper

Add alongside `getSupabaseClient`:

```ts
export function getAnonSupabaseClient(): SupabaseClient<Database> {
  // No Authorization header → runs as the Postgres `anon` role. Used only for
  // the no-session invitation-accept path, which authenticates via response_token
  // inside the accept_invitation SECURITY DEFINER RPC.
  // (url/anonKey resolved and validated exactly as in getSupabaseClient.)
  return createClient<Database>(url, anonKey);
}
```

Reuse the same env-var resolution + missing-var guard as `getSupabaseClient`.

### 3. `lib/supabase/types.ts` — type the new RPC

Add to `public.Functions`:

```ts
accept_invitation: {
  Args: { p_invitation_id: string; p_response_token: string | null };
  Returns: {
    status: InvitationStatus;
    already_responded: boolean;
    attendees_added: number;
  };
};
```

(`InvitationStatus` is already imported in this file.)

### 4. `lib/api/errors.ts` — add one error code

Add `EXPIRED: "EXPIRED",` to the `ErrorCode` object (the file's comment already
invites extension). Used for the expired-invitation response (HTTP 410).

### 5. `schemas/invitations.ts` — add accept body + id param schemas

```ts
export const acceptInvitationParamSchema = z.string().uuid();

// Body is optional: absent/empty for the in-app path; { responseToken } for the
// no-session SMS/email path. Token is the 64-char hex response_token.
export const acceptInvitationSchema = z.object({
  responseToken: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
```

### 6. `app/api/invitations/handler.ts` — add `acceptInvitation`

Signature (match the `lookup?` seam used across handlers for testability):

```ts
export async function acceptInvitation(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>
```

Behavior:

1. Validate `id` with `acceptInvitationParamSchema`; on failure → `fail("Validation failed", VALIDATION_FAILED, 400)`.
2. `const body = await req.json().catch(() => null);` then
   `acceptInvitationSchema.safeParse(body ?? {})`; on failure → 400 VALIDATION_FAILED.
   Let `responseToken = parsed.data.responseToken`.
3. **Choose client / path:**
   - If `responseToken` is present → `supabase = getAnonSupabaseClient()`;
     `p_response_token = responseToken`. (Do NOT call `requireAuth`.)
   - Else → `ctx = await requireAuth(req, lookup)` (throws 401 if no session);
     get the supabase JWT via `auth()`/`getToken({ template: "supabase" })`
     (401 UNAUTHENTICATED if no JWT, mirroring the other handlers);
     `supabase = getSupabaseClient(jwt)`; `p_response_token = null`.
4. Call `supabase.rpc("accept_invitation", { p_invitation_id: id, p_response_token })`.
5. **Map RPC errors** by matching `error.message` (Postgres RAISE message):
   - contains `"NOT_FOUND"` → `fail("Not found", NOT_FOUND, 404)`
   - contains `"FORBIDDEN"` → `fail("Forbidden", FORBIDDEN, 403)`
   - contains `"EXPIRED"` → `fail("Invitation expired", EXPIRED, 410)`
   - any other error → `fail("Internal error", INTERNAL, 500)`
6. On success return
   `ok({ invitationId: id, status: data.status, alreadyResponded: data.already_responded, attendeesAdded: data.attendees_added })`
   (HTTP 200).
7. Wrap in the same `try/catch (err) { if (err instanceof ApiException) ... }`
   envelope used by `createInvitation`.

Import `getAnonSupabaseClient` and the two new schema exports; keep existing imports.

### 7. `app/api/invitations/[id]/accept/route.ts` — wire params + handler

Replace the stub with (mirror `app/api/service-weeks/[id]/cancel/route.ts`):

```ts
import { NextRequest } from "next/server";
import { acceptInvitation } from "../../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return acceptInvitation(req, id);
}
```

### 8. `middleware.ts` — make the accept route public

Add to the `isPublicRoute` matcher array so the no-session SMS/email link
reaches the handler:

```ts
"/api/invitations/(.*)/accept",
```

The in-app authenticated path still works: Clerk still populates `auth()` from
the session cookie on public routes; the handler enforces auth itself
(`requireAuth`) whenever no `responseToken` is supplied.

---

## Edge cases the implementation MUST handle

- **No-session valid token** → 200, status `accepted`.
- **In-app authenticated member (own invite), no token** → 200, status `accepted`.
- **In-app member accepting someone else's invitation** (JWT user ≠ `invitation.user_id`)
  → 403 FORBIDDEN (RPC raises `FORBIDDEN`).
- **Wrong/mismatched token** → 403 FORBIDDEN.
- **No token AND no session** → 401 UNAUTHENTICATED (from `requireAuth`; RPC not reached).
- **Unknown invitation id** → 404 NOT_FOUND.
- **Malformed id (non-uuid)** → 400 VALIDATION_FAILED.
- **Malformed token in body (wrong length / non-hex)** → 400 VALIDATION_FAILED.
- **Already responded** (`status` is `accepted`/`denied`/`withdrawn`) → 200 with
  the current status and `alreadyResponded: true`. NOT an error. (#51 owns UI text.)
- **Expired** (`response_deadline` passed, still `pending`) → 410 EXPIRED. Checked
  AFTER the already-responded check, so a previously-accepted-but-now-past invite
  still returns 200 accepted.
- **Week has no events yet** → accept still succeeds; `attendeesAdded: 0` (queued
  for #59/#60). Not an error.
- **`invited_by` is null** → notify all admins/set_leaders in the group instead.
- **event_attendees already present** → `ON CONFLICT DO NOTHING`, no error.

---

## Patterns to copy (name the file)

- RPC shape / header comment / GRANT / DOWN block:
  `supabase/migrations/20260711000001_availability_conflict_rpc.sql` and
  `supabase/migrations/20260707000001_audit_log_write_rpc.sql`.
- Handler envelope (try/catch, `requireAuth`, `getToken` JWT guard, `ok`/`fail`):
  `app/api/invitations/handler.ts` (`createInvitation`) and
  `app/api/service-weeks/[id]/handler.ts`.
- Notification INSERT shape: `setServiceWeekCancelled` in
  `app/api/service-weeks/[id]/handler.ts`.
- Route param extraction: `app/api/service-weeks/[id]/cancel/route.ts`.
- Unit-test mocking (Clerk `auth`, `getSupabaseClient`, chainable client, `rpc`
  mock): `tests/unit/app/api/invitations-route.test.ts`. The tester will also
  need to mock `getAnonSupabaseClient` for the token path.

---

## Tests (guidance for the testing stage)

Create `tests/unit/app/api/invitations-accept-route.test.ts`, modelled on
`tests/unit/app/api/invitations-route.test.ts`. Mock `@clerk/nextjs/server`
`auth`, and BOTH `getSupabaseClient` and `getAnonSupabaseClient` from
`@/lib/supabase/client`. The supabase mock only needs an `rpc` method returning
`{ data, error }`. Cover at minimum:

- Happy path, token: `acceptInvitation(req({responseToken}), id)` → 200,
  `status: "accepted"`; assert `getAnonSupabaseClient` used and
  `rpc("accept_invitation", { p_invitation_id: id, p_response_token: token })`.
- Happy path, session: `acceptInvitation(req({}), id, makeLookup("member"))` → 200;
  assert `getSupabaseClient` used and `p_response_token: null`.
- Already responded: rpc returns `{ data: { status: "accepted", already_responded: true, attendees_added: 0 } }`
  → 200, `alreadyResponded: true`.
- 400 for non-uuid `id`; 400 for malformed `responseToken`.
- 401 when no token and no session (`auth` returns `{ userId: null }`).
- Failure mapping: rpc `error.message` `"NOT_FOUND"` → 404, `"FORBIDDEN"` → 403,
  `"EXPIRED"` → 410, other → 500.

Run `bun run lint`, `bun run typecheck`, `bun run test` (NOT bare `bun test`).

---

## Deferred / explicitly out of scope (do NOT implement)

- **Deny flow** (#42) — separate issue.
- **Google Calendar sync on accept** (#62) — leave a `TODO(#62)` comment only.
- **"Already responded" edge-case UI copy** (#51) — this spec only guarantees the
  graceful 200 + current-status response; no UI text.
- **BR-05 conflict-on-accept.** `createInvitation`'s comment says "the `conflicts`
  row itself is written at accept time (#41)", but issue #41's own Acceptance
  Criteria and Out-of-Scope do not list conflict recording, and conflict handling
  is tracked separately. To avoid inventing scope, conflict-row creation on accept
  is NOT implemented here. If a human wants it folded in, it belongs after step 5
  of the RPC (insert a `conflicts` row when the accepting user already has another
  `accepted` invitation for a service on the same `service_date`). Flagged so it
  is a conscious decision, not an omission.
