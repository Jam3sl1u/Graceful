# Spec — Issue #72: [Sprint 4] Guest invitation flow (existing vs. new user)

## OPEN QUESTIONS

**None blocking — do not stop the pipeline.** Three decisions a human should know
about are recorded here; each already has a defensible resolution baked into
this spec.

1. **Email dispatch is not available on this branch.** `lib/resend/client.ts`
   `sendEmail()` still throws (`"sendEmail not implemented — see Sprint 4 #59"`),
   and `verifyResendWebhook` is likewise a stub — the Resend work (GitHub #68)
   is on a different branch and is not merged into this one. So AC bullet 3
   ("invitation email sent with an account creation link") is implemented up to,
   but not including, the actual send: the handler **builds** the account-creation
   URL, **returns** it in the 201 response body, and leaves a
   `// TODO(#68): dispatch the guest invitation email with accountSetupUrl.`
   marker exactly like the existing `// TODO(#67/#68)` markers in
   `app/api/invitations/handler.ts`. **Never call `sendEmail` — it throws.**
2. **An existing user's role is never changed by a guest invitation.** If the
   invited email already belongs to a user in the group (member/set_leader/admin),
   the invitation is created against that existing `user_id` with their role
   untouched (PRD Flow 6 step 2a says only "invitations record created directly,
   user_id already known"). Silently demoting a member to `guest` would be a
   privilege change nobody asked for.
3. **`roleNote` stays optional**, mirroring `createInvitationSchema` and the
   nullable `invitations.role_note` column, even though the AC phrases it as
   "with a role note".

## Goal

Add the guest (4th role) invitation path: invite by email, branch on whether that
email already belongs to a Graceful user, let a brand-new guest claim an account
that auto-joins the group with role `guest`, and grant scoped week access on
acceptance without ever putting the guest on the music roster.

PRD refs: Flow 6 (§21.6), §10.1 Role Permission Summary.

## Current state (verified by reading the code — do not re-derive)

- `invitations.user_id` is `uuid NOT NULL REFERENCES users(id)`
  (`supabase/migrations/20260702000003_cluster_3_scheduling_core.sql:76-90`).
  There is therefore **no** "email-only, no user row" invitation shape. The
  new-user path must provision a placeholder `users` row first.
- `users` RLS: `INSERT` has **no** policy for `authenticated` (deny), so user
  provisioning must go through a `SECURITY DEFINER` RPC
  (`supabase/migrations/20260704000001_rls_policies.sql:69-93`).
  `users_delete_leader_admin` **does** exist (leader/admin, same group).
- `users.email` is `varchar(255) UNIQUE` **globally** (not per group) and
  nullable; `users.clerk_id` is `varchar(50) NOT NULL UNIQUE`; `users.name` is
  `NOT NULL`; `users.anonymized_at` exists (member removal, #28).
- Guest scoping **already exists** in: `app/api/service-weeks/handler.ts:53`,
  `app/api/service-weeks/[id]/handler.ts:43`,
  `app/api/service-weeks/[id]/setlist/handler.ts:69`,
  `app/api/events/handler.ts:43` — all "guest must have an invitation for this
  week, else 404". Guests are already excluded from `app/api/songs/handler.ts`
  and `app/api/songs/[id]/documents/handler.ts`.
- `app/api/service-weeks/[id]/member-view/handler.ts:62-73` is the **one**
  endpoint that explicitly defers guests to this issue: `requireRole(ctx,
  ["admin", "set_leader", "member"])` with the comment "guest variant is #72,
  out of scope".
- `accept_invitation` (`supabase/migrations/20260712000001_accept_invitation_rpc.sql`)
  inserts one `event_attendees` row per event of the week for the invitee —
  that table is what `member-view`'s `team` (the music roster) is derived from.
- `deny_invitation` (`supabase/migrations/20260713000002_deny_invitation_rpc.sql`)
  **already notifies** `invited_by` (or all admins/set_leaders) in-app. AC bullet 5's
  "admin notified" therefore needs **no new code** — guests inherit it.
- The public token screens already work session-lessly for anyone:
  `app/(public)/invite/[token]/` + `GET /api/invitations/respond/:token` +
  the `responseToken` branches of accept/deny. Guests reuse them as-is.
- `middleware.ts` public routes: `/`, `/sign-in(.*)`, `/sign-up(.*)`,
  `/join(.*)`, `/invite(.*)`, `/api/health`, `/api/webhooks(.*)`,
  `/api/invitations/(.*)/accept`, `/api/invitations/(.*)/deny`,
  `/api/invitations/respond/(.*)`.
- `NEXT_PUBLIC_APP_URL` already exists in `.env.example` ("used for OAuth
  redirects, invite links, email/SMS links"). Do not add env vars.

## Design decisions (implement exactly these)

- **New-user path = placeholder `users` row + claim.** Invite time: a
  `SECURITY DEFINER` RPC inserts a `users` row with
  `role='guest'`, `email` = the invited email, and a synthetic
  `clerk_id` of the form `pending_guest_<32 hex>`. Signup time: a second
  `SECURITY DEFINER` RPC swaps that synthetic `clerk_id` for the real Clerk
  `sub`. The invitation is "linked" from the moment it is created, because it
  already points at that `users.id`.
- **Guests never get `event_attendees` rows** — that row *is* the music-roster
  slot (it drives `member-view.team`, the attendees endpoints and the ICS feeds).
  `accept_invitation` gains a role branch.
- **Guest week access = an invitation whose status is `pending` or `accepted`.**
  `denied` / `withdrawn` / `expired` grant nothing (AC bullet 5, "no further
  access granted"). Factored into one helper and applied to the four guest
  branches (three existing + the new member-view one), which also fixes a latent
  bug: those three use `.maybeSingle()`, which **errors** when a member has been
  re-invited and has two invitation rows for the same week.

## Files to create

### 1. `supabase/migrations/20260805000001_guest_invitation_flow.sql` (new)

Follow the header-comment + `-- ============ UP ============` /
`-- ============ DOWN ============` style of
`supabase/migrations/20260710000001_member_removal_rpc.sql`. All three functions:
`LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = ''`, every
reference schema-qualified (`public.` / `auth.jwt()`).

**a. `public.provision_guest_user(p_email text, p_name text) RETURNS public.users`**

1. `v_clerk_id := auth.jwt() ->> 'sub'`; NULL → `RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001'`.
2. Look up caller's `church_group_id` + `role` from `public.users`; missing →
   `UNAUTHENTICATED`; role not in (`admin`,`set_leader`) → `FORBIDDEN`.
   (Copy the caller-check block from `remove_church_group_member`, including its
   comment that this check — not RLS — is the real enforcement point.)
3. `IF EXISTS (SELECT 1 FROM public.users WHERE lower(email) = lower(p_email))
   THEN RAISE EXCEPTION 'EMAIL_TAKEN' ...` (global check: the unique index is global).
4. `INSERT INTO public.users (clerk_id, church_group_id, role, name, email)
   VALUES ('pending_guest_' || md5(random()::text || clock_timestamp()::text),
           v_caller_group, 'guest', left(p_name, 100), lower(p_email))
   RETURNING * INTO v_user;`
   Comment why `md5(random()||clock_timestamp())` and not `gen_random_uuid()`:
   with `search_path = ''` the pgcrypto function would need a schema qualifier
   whose schema differs between local and Supabase-hosted installs, whereas
   `md5`/`random`/`clock_timestamp` are `pg_catalog` builtins. 14 + 32 = 46 chars,
   inside `clerk_id varchar(50)`.
5. `GRANT EXECUTE ON FUNCTION public.provision_guest_user(text, text) TO authenticated;`

**b. `public.claim_guest_invitation(p_response_token text, p_name text) RETURNS jsonb`**

Model on `join_church_group` (`20260706000002`) for shape and on
`accept_invitation` for the direct `audit_logs` insert.

1. `v_clerk_id := auth.jwt() ->> 'sub'`; NULL → `UNAUTHENTICATED`.
2. `SELECT * INTO v_inv FROM public.invitations WHERE response_token = p_response_token;`
   `NOT FOUND` → `NOT_FOUND`.
3. `SELECT * INTO v_guest FROM public.users WHERE id = v_inv.user_id FOR UPDATE;`
4. Idempotent re-claim: `IF v_guest.clerk_id = v_clerk_id THEN` return
   `jsonb_build_object('user_id', v_guest.id, 'church_group_id', v_guest.church_group_id,
   'invitation_id', v_inv.id, 'service_week_id', v_inv.service_week_id,
   'already_claimed', true)` with no mutation and no audit row.
5. `IF v_guest.anonymized_at IS NOT NULL THEN RAISE ... 'NOT_FOUND'`.
6. `IF NOT starts_with(v_guest.clerk_id, 'pending_guest_') OR v_guest.role <> 'guest'
   THEN RAISE ... 'ALREADY_CLAIMED'` (the invitation belongs to a real account).
7. `IF v_inv.status NOT IN ('pending', 'accepted') THEN RAISE ... 'NOT_CLAIMABLE'`.
8. `IF EXISTS (SELECT 1 FROM public.users WHERE clerk_id = v_clerk_id)
   THEN RAISE ... 'USER_ALREADY_IN_GROUP'` (the signer-in already has an identity;
   never merge accounts).
9. `UPDATE public.users SET clerk_id = v_clerk_id,
      name = COALESCE(NULLIF(left(p_name, 100), ''), name), updated_at = now()
    WHERE id = v_guest.id;`
   **Never touch `email`** — the invited address is the identity we vetted, and
   overwriting it can trip the global unique index.
10. `INSERT INTO public.audit_logs (church_group_id, user_id, action, entity_type, entity_id, metadata)`
    with `action = 'invitation.guest_claimed'`, `entity_type = 'invitation'`,
    `entity_id = v_inv.id`, `metadata = jsonb_build_object('user_id', v_guest.id)`.
11. Return the same jsonb shape as step 4 with `'already_claimed', false`.
12. `GRANT EXECUTE ON FUNCTION public.claim_guest_invitation(text, text) TO authenticated;`

**c. `CREATE OR REPLACE FUNCTION public.accept_invitation(uuid, text)`**

Copy the **entire** body from `20260712000001_accept_invitation_rpc.sql` verbatim
(same signature, same `GRANT ... TO anon, authenticated;`) and change only:

- declare `v_invitee_role public.user_role;`
- immediately before the `event_attendees` insert:
  ```
  -- #72: a guest never occupies a music-roster slot (PRD §10.1 / Flow 6 5a),
  -- and event_attendees IS that slot — skip the insert for guests.
  SELECT role INTO v_invitee_role FROM public.users WHERE id = v_inv.user_id;
  IF v_invitee_role = 'guest' THEN
    v_attendees_added := 0;
  ELSE
    <existing INSERT ... ON CONFLICT DO NOTHING; GET DIAGNOSTICS ...>
  END IF;
  ```
- Header comment must state it supersedes the version in `20260712000001` and why.

### 2. `lib/invitations/guest-access.ts` (new)

`import "server-only";` at the top (see `lib/api/auth.ts`).

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { InvitationStatus } from "@/types/domain";

// An invitation in one of these statuses is what grants a guest scoped read
// access to their week (PRD Flow 6 5a/5b): denied/withdrawn/expired grant
// nothing.
export const GUEST_ACCESS_STATUSES: InvitationStatus[] = ["pending", "accepted"];

export type GuestAccessResult = { allowed: boolean; dbError: boolean };

export async function guestHasWeekAccess(
  supabase: SupabaseClient<Database>,
  serviceWeekId: string,
  userId: string,
): Promise<GuestAccessResult>;
```

Implementation: `supabase.from("invitations").select("id")
.eq("service_week_id", serviceWeekId).eq("user_id", userId)
.in("status", GUEST_ACCESS_STATUSES).limit(1)` — awaited directly, **no
`.maybeSingle()`** (a re-invited user legitimately has several rows and
`maybeSingle()` errors on >1). Return `{ allowed: false, dbError: true }` on
`error`, else `{ allowed: (data ?? []).length > 0, dbError: false }`. Never throws.

### 3. `app/api/invitations/guest/route.ts` (new)

Copy the shape of `app/api/invitations/route.ts`:

```ts
import { NextRequest } from "next/server";
import { createGuestInvitation } from "../handler";

export async function POST(req: NextRequest): Promise<Response> {
  return createGuestInvitation(req);
}
```

### 4. `app/api/invitations/guest/claim/route.ts` (new)

Same shape, calling `claimGuestInvitation(req)`.

### 5. `app/(public)/guest/[token]/page.tsx` (new)

Server component mirroring `app/(public)/join/[code]/page.tsx`, plus a
signed-out branch:

```tsx
export default async function GuestClaimPage({
  params,
}: { params: Promise<{ token: string }> }): Promise<React.ReactElement>
```
- `const { token } = await params;`
- `const { userId } = await auth();` (from `@clerk/nextjs/server`).
- Signed out → render a short `<main>` explaining they need an account plus an
  anchor to `` `/sign-up?redirect_url=${encodeURIComponent(`/guest/${token}`)}` ``
  and a secondary anchor to the same URL under `/sign-in`.
- Signed in → `<GuestClaimForm token={token} />`.

### 6. `app/(public)/guest/[token]/guest-claim-form.tsx` (new)

`"use client"` component copied almost verbatim from
`app/(public)/join/[code]/join-form.tsx` (same `status` state machine, same
inline `style` approach, same `role="alert"` error paragraph):

```tsx
export default function GuestClaimForm({ token }: { token: string }): React.ReactElement
```
- Button "Finish setting up your account" → `POST /api/invitations/guest/claim`
  with `{ "Content-Type": "application/json" }` and body
  `JSON.stringify({ responseToken: token })`.
- On `res.ok` → success view with an anchor to `/invite/${token}`
  ("View your invitation") — that public screen is where accept/decline happens.
- On failure → `body?.error ?? "Something went wrong. Please try again."`.

## Files to modify

### 7. `schemas/invitations.ts`

Append (keep the file's existing comment style — every export has a `#issue`
comment):

```ts
// POST /api/invitations/guest body (#72). email is normalized to lowercase
// here so the handler's existing-user lookup and the RPC insert agree.
export const createGuestInvitationSchema = z.object({
  serviceWeekId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(255),
  name: z.string().trim().min(1).max(100).optional(),
  roleNote: z.string().trim().min(1).max(500).optional(),
  acknowledgeConflict: z.boolean().optional(),
});
export type CreateGuestInvitationInput = z.infer<typeof createGuestInvitationSchema>;

// POST /api/invitations/guest/claim body (#72). Same 64-char hex response_token
// shape as acceptInvitationSchema.
export const claimGuestInvitationSchema = z.object({
  responseToken: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
});
export type ClaimGuestInvitationInput = z.infer<typeof claimGuestInvitationSchema>;
```

### 8. `lib/supabase/types.ts`

Add to `Database["public"]["Functions"]` (same style as the neighbours):

```ts
provision_guest_user: {
  Args: { p_email: string; p_name: string };
  Returns: UsersRow;
};
claim_guest_invitation: {
  Args: { p_response_token: string; p_name: string | null };
  Returns: {
    user_id: string;
    church_group_id: string;
    invitation_id: string;
    service_week_id: string;
    already_claimed: boolean;
  };
};
```

### 9. `app/api/invitations/handler.ts` — add two exported handlers

Both live in this file so they can reuse the module-private
`generateResponseToken()` and `toInvitationResponse()`.

```ts
export type GuestInvitationResponse = {
  invitation: InvitationResponse;
  isNewUser: boolean;
  guestUserId: string;
  email: string;
  inviteUrl: string;            // `${base}/invite/${response_token}`
  accountSetupUrl: string | null; // `${base}/guest/${response_token}`, null when isNewUser === false
};

export async function createGuestInvitation(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response>;

export async function claimGuestInvitation(req: NextRequest): Promise<Response>;
```

**`createGuestInvitation`** — structure it as a near-copy of `createInvitation`
(same `try` / `ApiException` tail, same 401-on-missing-JWT, same
`as unknown as Database["public"]["Tables"]["invitations"]["Insert"]` cast):

1. `requireAuth` → `requireRole(ctx, ["admin", "set_leader"])`.
2. `createGuestInvitationSchema.safeParse(await req.json().catch(() => null))`;
   failure → 400 `VALIDATION_FAILED`.
3. `getToken({ template: "supabase" })` → `getSupabaseClient(jwt)`.
4. Service week lookup — identical query and identical 404-not-403 comment as
   `createInvitation`.
5. Existing-user lookup:
   `supabase.from("users").select("id").eq("church_group_id", ctx.churchGroupId)
   .eq("email", parsed.email).is("anonymized_at", null).limit(1)` (awaited, no
   `maybeSingle()`); `error` → 500.
6. **Existing-user branch** (`isNewUser = false`): run the *unchanged* BR-08
   denial-cap check and BR-05 double-booking check from `createInvitation`
   against that `user_id` (same 409 messages and `acknowledgeConflict` escape
   hatch). Do **not** modify that user's role.
7. **New-user branch** (`isNewUser = true`): skip BR-08/BR-05 (a fresh row has
   no prior invitations by construction — say so in a comment), then
   `supabase.rpc("provision_guest_user", { p_email: parsed.email, p_name: guestName })`
   where `guestName = parsed.name ?? parsed.email.split("@")[0]` truncated to 100.
   Map RPC errors by substring, mirroring `acceptInvitation`'s error mapping:
   `FORBIDDEN` → 403, `UNAUTHENTICATED` → 401, `EMAIL_TAKEN` → 409 CONFLICT
   ("A user with this email already exists"), anything else → 500.
8. Insert the invitation with exactly the payload `createInvitation` uses
   (`church_group_id`, `service_week_id`, `user_id`, `role_note: parsed.roleNote ?? null`,
   `response_token: generateResponseToken()`, `response_deadline` = now + 72 h,
   `invited_by: ctx.userId`), `.select("*").maybeSingle()`.
   **If this fails on the new-user branch**, best-effort
   `await supabase.from("users").delete().eq("id", guestUserId)` (allowed by
   `users_delete_leader_admin`) before returning 500, so a failed invite does not
   leave an orphan placeholder account. Comment why.
9. `writeAuditLog(supabase, { action: "invitation.sent", entityType: "invitation",
   entityId: invitation.id, metadata: { service_week_id, user_id, guest: true,
   is_new_user: isNewUser } })` — reuse the existing action string, do not invent
   a new one.
10. `// TODO(#68): dispatch the guest invitation email with accountSetupUrl.`
    (Do not import or call `sendEmail`.)
11. `return ok<GuestInvitationResponse>({...}, 201)`.

URL building (module-private helper in this file):
```ts
// NEXT_PUBLIC_APP_URL is optional at runtime; fall back to a site-relative URL
// rather than throwing, so an unconfigured preview env still returns a usable link.
function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return `${base}${path}`;
}
```

**`claimGuestInvitation`** — deliberately does **not** call `requireAuth`
(the claimer has no `users` row yet, so it would always 401). Copy the auth
preamble of `app/api/church-group/join/route.ts`:

1. `const { userId: clerkId, getToken } = await auth();` — no `clerkId` → 401
   `UNAUTHENTICATED`; no `jwt` → 401.
2. Parse body with `claimGuestInvitationSchema`; failure → 400.
3. `const user = await currentUser();` and derive a display name the same way
   `deriveMemberName` does in the join route (a module-private copy here is fine;
   default to `null` instead of `"Member"` when nothing usable exists, since the
   RPC keeps the existing name on `NULL`).
4. `getSupabaseClient(jwt).rpc("claim_guest_invitation", { p_response_token, p_name })`.
5. Error mapping by substring: `UNAUTHENTICATED` → 401, `NOT_FOUND` → 404,
   `ALREADY_CLAIMED` → 409, `NOT_CLAIMABLE` → 409, `USER_ALREADY_IN_GROUP` → 409,
   else 500.
6. `ok({ guest: { userId: data.user_id, churchGroupId: data.church_group_id },
   invitationId: data.invitation_id, serviceWeekId: data.service_week_id,
   alreadyClaimed: data.already_claimed }, 201)`.

### 10. `app/api/service-weeks/[id]/member-view/handler.ts`

- Change `requireRole(ctx, ["admin", "set_leader", "member"])` →
  `requireRole(ctx, ["admin", "set_leader", "member", "guest"])`, and replace the
  "guest variant is #72, out of scope" comment with the new rule.
- Immediately after the week 404 check, add:
  ```ts
  if (ctx.role === "guest") {
    const access = await guestHasWeekAccess(supabase, id, ctx.userId);
    if (access.dbError) return fail("Internal error", ErrorCode.INTERNAL, 500);
    if (!access.allowed) return fail("Not found", ErrorCode.NOT_FOUND, 404);
  }
  ```
  (404, never 403 — same anti-enumeration rule as the sibling handlers.)
- In the team-directory query, also select `role` and filter guests out of
  `team`: defence in depth, so a user who is demoted to `guest` after already
  having `event_attendees` rows still never renders as a roster slot. Keep the
  existing `.is("anonymized_at", null)`.

### 11. Apply the shared helper to the three existing guest branches

`app/api/service-weeks/[id]/handler.ts` (~line 43),
`app/api/service-weeks/[id]/setlist/handler.ts` (~line 69),
`app/api/events/handler.ts` (~line 43 — this one lists *all* the caller's
invitations rather than one week's; there, add `.in("status", GUEST_ACCESS_STATUSES)`
to the existing query instead of calling the helper, and only for
`ctx.role === "guest"` so member/set_leader scoping is unchanged).

For the two week-scoped handlers, replace the inline
`.select("id").eq(...).eq(...).maybeSingle()` block with `guestHasWeekAccess(...)`,
preserving each call site's existing 500/404 behaviour and comments.

### 12. `app/(app)/week/[id]/week-view.tsx` — guest invite UI (minimal)

- Add `role: string` to the local `DirectoryMember` type (the API already returns it).
- Roster: build it from `members.filter((m) => m.role !== "guest")` so a guest
  never occupies a music-roster row.
- Add a "Guests" section below the roster listing `members.filter((m) => m.role === "guest")`
  that have an invitation for this week (reuse `getCurrentInvitation` + `Badge`,
  showing the invitation status label).
- Add an "Invite a guest" form in that section: a `type="email"` input
  (`required`), an optional role-note text input, and a `Button` that POSTs to
  `/api/invitations/guest` with `{ serviceWeekId, email, roleNote }`. Mirror
  `handleInvite`'s structure (guard on an in-flight flag, `setInviteError` on
  failure, push the returned `body.data.invitation` into `invitations` on success).
  On success where `body.data.isNewUser === true`, render
  `body.data.accountSetupUrl` as selectable text with the note that the guest
  needs this link to create their account (until #68 sends it by email).
- Reuse existing classes from `week-view.module.css`; add at most the classes you
  genuinely need to `week-view.module.css`. No redesign.

### 13. `middleware.ts`

Add `"/guest(.*)"` to the `isPublicRoute` list (next to `"/join(.*)"`), so the
claim page can render its own signed-out branch. `POST /api/invitations/guest`
and `/api/invitations/guest/claim` must stay **protected** — do not add any
`/api/invitations/guest` pattern.

## Edge cases the implementation must handle

1. **Email already belongs to a user in this group** → existing-user path, no new
   `users` row, `isNewUser: false`, `accountSetupUrl: null`, role unchanged.
2. **Email belongs to a user in a *different* group** → the group-scoped lookup
   (RLS + explicit `church_group_id` filter) does not see them, so the code takes
   the new-user path and `provision_guest_user` hits the global unique email →
   `EMAIL_TAKEN` → **409**, never a 500 and never a cross-tenant leak of who owns it.
3. **Email belongs to an anonymized (removed) member** → excluded by
   `.is("anonymized_at", null)`; removal already NULLs `email`, so provisioning
   succeeds.
4. **Case/whitespace in email** → normalized once in the Zod schema (`trim` +
   `toLowerCase`); the RPC also `lower()`s defensively.
5. **Service week missing or in another group** → 404 (never 403), same as
   `createInvitation`.
6. **Non-admin/non-set-leader caller** → 403 from `requireRole`; the RPC's own
   caller check is the backstop (it runs `SECURITY DEFINER`, bypassing RLS).
7. **Invitation insert fails after a new guest was provisioned** → delete the
   orphan `users` row (best-effort), return 500.
8. **Claim with an unknown/garbage token** → 404 (the Zod shape check rejects
   malformed tokens with 400 before the RPC; that asymmetry is fine here because
   this endpoint requires a session, unlike `getInvitationByToken`).
9. **Claim twice by the same Clerk user** → 201 with `alreadyClaimed: true`, no
   second audit row, no mutation.
10. **Claim by someone who already has a `users` row** (e.g. an existing member
    clicked the setup link) → 409 `USER_ALREADY_IN_GROUP`; accounts are never merged.
11. **Claim of an invitation whose placeholder was already claimed by another
    Clerk account** → 409 `ALREADY_CLAIMED`.
12. **Claim of a withdrawn/denied/expired invitation** → 409 `NOT_CLAIMABLE`
    (no account is created into the group off a dead invitation).
13. **Guest accepts** → `accept_invitation` returns `attendeesAdded: 0` and writes
    **zero** `event_attendees` rows; the status flip, admin notification and audit
    row are unchanged. A guest's `member-view` therefore shows every event with
    `assigned: false` — that is the intended outcome, not a bug.
14. **Guest denies** → existing `deny_invitation` notifies the admin; the guest's
    subsequent `member-view` / week / setlist / events requests all 404 because
    `denied` is not in `GUEST_ACCESS_STATUSES`.
15. **Guest with two invitation rows for one week** (re-invite after a denial) →
    the helper's `.limit(1)` array query must not use `.maybeSingle()`.
16. **`NEXT_PUBLIC_APP_URL` unset** → site-relative URLs, no throw.
17. **Guest hitting a week they were never invited to** → 404 from every endpoint.

## Tests the coder must add (Jest, `bun run test`)

Follow `tests/unit/app/api/invitations-route.test.ts` exactly for the mocking
pattern (`jest.mock("@clerk/nextjs/server")`, `jest.mock("@/lib/supabase/client")`,
per-table chainable fixtures, `makeLookup(role)`).

- `tests/unit/lib/invitations/guest-access.test.ts` — allowed (`pending`,
  `accepted`), not allowed (`denied` only / no rows), `dbError: true` on error,
  and the multi-row case returning `allowed: true`.
- `tests/unit/app/api/invitations-guest-route.test.ts` — 401 unauth; 403 member;
  400 bad email; 404 unknown week; existing-user happy path (`isNewUser: false`,
  `accountSetupUrl: null`, RPC **not** called); new-user happy path
  (`provision_guest_user` called with the lowercased email, `isNewUser: true`,
  `accountSetupUrl` ends with `/guest/<token>`); `EMAIL_TAKEN` → 409; BR-08 cap
  → 409 on the existing-user path; orphan cleanup (`users.delete`) when the
  invitation insert fails on the new-user path.
- `tests/unit/app/api/invitations-guest-claim-route.test.ts` — 401 without a
  Clerk session; 400 malformed token; RPC error → status mapping for each of
  `NOT_FOUND` / `ALREADY_CLAIMED` / `NOT_CLAIMABLE` / `USER_ALREADY_IN_GROUP`;
  happy path 201; `alreadyClaimed: true` passthrough.
- Extend `tests/unit/app/api/service-weeks-member-view-route.test.ts` — guest with
  an `accepted` invitation gets 200; guest with a `denied`-only invitation gets 404;
  guest with no invitation gets 404; a `guest`-role user is filtered out of `team`.

## Explicitly out of scope (do not implement)

- Any use of `sendEmail` / Resend / SMS dispatch (#67/#68).
- Week chat (the AC calls it a placeholder — there is no chat table in Phase 1).
- Hiding key/instrument *columns* from the guest's read-only week view, guest
  inbox scoping, and any other UI polish beyond items 12 and 5/6 above.
- Changing `getChurchGroupMembers`, the availability endpoints, or any RLS policy.
- Regenerating `lib/supabase/types.ts` wholesale — hand-add only the two
  `Functions` entries.

## Verification before finishing

```
bun run lint
bun run typecheck
bun run test
bun run check:service-role
```
All four must pass. `check:service-role` matters here: none of the new code may
touch `SUPABASE_SERVICE_ROLE_KEY` — the two new RPCs exist precisely so it isn't
needed. The SQL migration is not executed by CI; keep it self-consistent and
idempotent-safe (`CREATE OR REPLACE`).
