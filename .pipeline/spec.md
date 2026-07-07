# Spec — Issue #26: Member directory endpoint (`GET /api/church-group/members`)

## OPEN QUESTIONS (non-blocking — defaults chosen, proceed)

1. **Live availability status.** The `availability` table exists (issue #20,
   `20260702000005_cluster_5_partial.sql`), but the issue's Implementation Notes
   explicitly say: "ship the directory shape now and wire in real-time status once
   **#34** lands." There is no "current status" concept on the table — it stores one
   `is_available` row per `(user_id, date)`, with no notion of "today live."
   **Decision for this issue:** include an `availabilityStatus` field in every member
   object, always set to `null` (placeholder), with a code comment referencing #34.
   Do **not** query the `availability` table in this issue. This satisfies AC-1's
   "directory shape" without inventing date/timezone logic that belongs to #34.

2. **Do guests appear as rows in the directory?** Guests are group members with a
   `guest` role. AC-4 says "Guests seeing nothing here" — that refers to guests *as
   the caller* (they get 403). It does not say to hide guest *rows* from other
   viewers. **Decision:** the directory lists **all `users` rows in the caller's
   group regardless of role** (this is what the RLS `users_select_tenant` policy
   already returns). Simple and matches "everyone in my group." Do not filter by role.

Neither of these blocks implementation. If a human disagrees, only the two spots
above change.

---

## Goal (scope of THIS issue)

Implement `GET /api/church-group/members`: return every user in the caller's church
group with their instruments and vocal capability. Contact details (email/phone) are
included **only when the caller is an `admin`**. Guests (as caller) get 403. The
availability field ships as a `null` placeholder (see OPEN QUESTION 1).

Out of scope: any UI/screen, real-time availability wiring (#34), role assignment
(#27), member removal (#28). Do not touch other routes.

---

## Current state (already done — do NOT redo)

- `app/api/church-group/members/route.ts` exists as a `notImplemented` stub — you
  will replace its `GET`.
- All required tables already exist and are RLS group-scoped for `SELECT` to
  `authenticated` (`20260704000001_rls_policies.sql`): `users`
  (`users_select_tenant`), `member_profiles` (`member_profiles_select_tenant`),
  `member_instruments` (`member_instruments_select_tenant`), `instruments`
  (`instruments_select_tenant`). **No new migration is needed.**
- Request-level auth is enforced by `middleware.ts` (this route is not in
  `isPublicRoute`, so Clerk `auth.protect()` already covers it). Role-level and
  group-scoping are enforced in the handler + RLS.

Table columns you will rely on (from the migrations):
- `users`: `id`, `church_group_id`, `role`, `name`, `email` (nullable), `phone`
  (nullable).
- `member_profiles`: `id`, `user_id` (unique), `vocal_capability`
  (`'none'|'lead'|'harmony'|'both'`, NOT NULL default `'none'`). A user may have
  **no** profile row.
- `member_instruments`: `member_profile_id`, `instrument_id`.
- `instruments`: `id`, `church_group_id`, `name`.

---

## Files to create / modify

### 1. MODIFY `app/api/church-group/members/route.ts`

Replace the file. Keep no other exports. Pattern to copy for the
`requireAuth` + `requireRole` + lookup-seam + try/catch + `ok`/`fail` envelope:
**`app/api/_examples/admin-only/route.ts`**. Pattern to copy for turning the Clerk
JWT into a Supabase client: **`lib/api/auth.ts`** (`lookupUserByClerkId` — `auth()`,
`getToken({ template: "supabase" })`, `getSupabaseClient(jwt)`).

**Signature (the second `lookup` param is required for unit testing the role):**
```ts
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { UserRole, VocalCapability } from "@/types/domain";

export async function GET(req: NextRequest, lookup?: UserLookup): Promise<Response>
```

**Response shape** (define this type in the route file and export it):
```ts
export type DirectoryMember = {
  id: string;                 // users.id
  name: string;
  role: UserRole;
  vocalCapability: VocalCapability;   // 'none' when the user has no member_profile
  instruments: { id: string; name: string }[];
  availabilityStatus: null;   // placeholder for #34 — see spec OPEN QUESTION 1
  email?: string | null;      // present ONLY when caller is admin
  phone?: string | null;      // present ONLY when caller is admin
};
```
Success body: `ok({ members })` → `{ "data": { "members": DirectoryMember[] } }`.
For non-admin callers, the `email` and `phone` keys must be **absent from the
object entirely** (not `null`) — omit them, do not set them.

**Handler behavior, in order:**
1. `const ctx = await requireAuth(req, lookup);` — 401 `UNAUTHENTICATED` is thrown
   by `requireAuth` when there is no Clerk session or no `users` row.
2. `requireRole(ctx, ["admin", "set_leader", "member"]);` — throws 403 `FORBIDDEN`
   for `guest`. (AC-4: guests see nothing here.)
3. Build the Supabase client from the Clerk JWT:
   `const { getToken } = await auth();`
   `const jwt = await getToken({ template: "supabase" });`
   if `!jwt` → `return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);`
   `const supabase = getSupabaseClient(jwt);`
4. Run these queries. Explicitly filter `church_group_id` where the column exists
   (defense in depth on top of RLS — AC-3):
   - `usersRes = await supabase.from("users")
       .select("id, name, role, email, phone")
       .eq("church_group_id", ctx.churchGroupId);`
   - `profilesRes = await supabase.from("member_profiles")
       .select("id, user_id, vocal_capability");`  // RLS scopes to group
   - `miRes = await supabase.from("member_instruments")
       .select("member_profile_id, instrument_id");`  // RLS scopes to group
   - `instrRes = await supabase.from("instruments")
       .select("id, name")
       .eq("church_group_id", ctx.churchGroupId);`
5. If any of the four results has a non-null `.error` →
   `return fail("Internal error", ErrorCode.INTERNAL, 500);`
   (or `throw new ApiException("Internal error", ErrorCode.INTERNAL, 500)` and let
   the catch handle it — either is fine; match the admin-only pattern's catch.)
6. Assemble in JS (no SQL joins needed):
   - Build `instrumentNameById: Map<instrumentId, name>` from `instrRes.data`.
   - Build `profileByUserId: Map<userId, {profileId, vocalCapability}>` from
     `profilesRes.data`.
   - Build `instrumentsByProfileId: Map<profileId, {id,name}[]>` from `miRes.data`,
     resolving each `instrument_id` via `instrumentNameById` (skip any id with no
     matching instrument name).
   - For each `user` in `usersRes.data`, produce a `DirectoryMember`:
     - `vocalCapability` = profile's value if the user has a profile, else `'none'`.
     - `instruments` = the profile's instrument list, else `[]`.
     - `availabilityStatus: null`.
     - If `ctx.role === 'admin'`, add `email: user.email` and `phone: user.phone`;
       otherwise omit both keys.
7. `return ok({ members });`

**Catch block** (copy from admin-only route):
```ts
} catch (err) {
  if (err instanceof ApiException) return fail(err.message, err.code, err.status);
  return fail("Internal error", ErrorCode.INTERNAL, 500);
}
```

Do NOT sort/paginate — return all members in whatever order the query yields
(ordering is not an AC; keep it minimal).

### 2. MODIFY `lib/supabase/types.ts`

The queries above must typecheck (`bun run typecheck`). The current `UsersRow` lacks
`name`, `email`, `phone`, and there are no types for `member_profiles`,
`instruments`, `member_instruments`. Extend `Database["public"]["Tables"]`, keeping
the existing minimal hand-written style (each table needs `Row`, `Insert`, `Update`,
`Relationships: []`). Make these changes:

- Add to `UsersRow`: `name: string; email: string | null; phone: string | null;`
  (keep existing `id`, `clerk_id`, `church_group_id`, `role`). Do NOT change
  `lib/api/auth.ts` — its `.select("id, church_group_id, role")` stays valid.
- Add table `member_profiles` with
  `Row = { id: string; user_id: string; vocal_capability: VocalCapability;
  bio: string | null; created_at: string }`. Import `VocalCapability` from
  `@/types/domain` (already imports `UserRole` from there).
- Add table `instruments` with
  `Row = { id: string; church_group_id: string; name: string;
  is_default: boolean; created_by: string | null; created_at: string }`.
- Add table `member_instruments` with
  `Row = { id: string; member_profile_id: string; instrument_id: string }`.
- Leave `church_groups` and the `create_church_group` function entry as-is.

Keep the file otherwise minimal; do not add tables unrelated to this issue.

---

## Edge cases the implementation must handle

- **Guest caller** → 403 `FORBIDDEN` (never returns directory data).
- **Unauthenticated** (no Clerk session, or `getToken` returns no JWT) → 401
  `UNAUTHENTICATED`.
- **Non-admin caller (member / set_leader)** → members returned but each object has
  **no** `email`/`phone` keys (AC-2: enforced server-side, not just UI).
- **Admin caller** → each member includes `email` and `phone` (either may be `null`
  when the DB column is null).
- **User with no `member_profiles` row** → `vocalCapability: 'none'`,
  `instruments: []` (do not drop the user from the list).
- **User with a profile but no `member_instruments` rows** → `instruments: []`.
- **A `member_instruments` row whose `instrument_id` has no matching `instruments`
  row** → skip that entry (don't emit `{id, name: undefined}`).
- **Caller is the only user in the group** → returns a one-element array containing
  the caller.
- **Any of the four DB queries errors** → 500 `INTERNAL` (do not return a partial
  directory).
- Cross-group isolation is guaranteed by RLS + the explicit `church_group_id`
  filters; a member from another group must never appear (AC-3).

---

## Patterns to follow (name the file)

- Route structure (`requireAuth` + `requireRole` + `lookup?` seam + try/catch +
  `ok`/`fail`): `app/api/_examples/admin-only/route.ts`.
- Clerk JWT → Supabase client: `lib/api/auth.ts` (`lookupUserByClerkId`).
- Error codes / `ApiException`: `lib/api/errors.ts` (`ErrorCode.FORBIDDEN`,
  `UNAUTHENTICATED`, `INTERNAL`).
- Success/error envelope: `lib/api/response.ts` (`ok`, `fail`); envelope shape in
  `types/api.ts`.
- Hand-written Supabase types style: existing entries in `lib/supabase/types.ts`.

---

## Tests the coder should add (tester will expand)

Create `tests/unit/app/api/church-group-members-route.test.ts`. Combine the two
existing patterns:
- Role/lookup-seam mocking from `tests/unit/app/api/admin-only-route.test.ts`
  (`makeLookup(role)` returning an `AuthContext`; mock `@clerk/nextjs/server`
  `auth`).
- Supabase-client mocking from `tests/unit/app/api/church-group-route.test.ts`
  (`jest.mock("@/lib/supabase/client", ...)`, mock `getSupabaseClient`).

Because the handler calls `auth()` again for `getToken`, mock `auth` to resolve
`{ userId: "clerk_test", getToken: jest.fn().mockResolvedValue("jwt") }`.

Mock the Supabase client so `from(table)` returns an object whose
`.select(...).eq(...)` (and `.select(...)` without `.eq`) resolves to
`{ data, error }`. A small helper that switches on the table name and returns the
right fixture array is the clean approach. Suggested fixtures: two users in the
group (one admin caller, one member with a profile + one instrument; and one user
with **no** profile), one instrument row, matching `member_instruments` and
`member_profiles` rows.

Cases to cover:
- 401 when Clerk `userId` is null (lookup never consulted).
- 403 when `role = 'guest'`.
- 200 for `role = 'admin'` → members include `email` + `phone` keys.
- 200 for `role = 'member'` and `role = 'set_leader'` → member objects have **no**
  `email`/`phone` keys (assert `"email" in member === false`).
- Instruments mapped correctly (`instruments: [{ id, name }]`) for the member with a
  profile.
- User without a `member_profiles` row → `vocalCapability: 'none'`,
  `instruments: []`, still present in the list.
- Every member has `availabilityStatus: null`.
- 500 when any query returns an `error`.

RLS/cross-tenant behavior (that another group's users never appear) is covered by
`tests/integration/rls/` and is out of scope for this unit test.

---

## Explicitly out of scope

- Any directory UI/screen (folded into #74 / #48 later — see issue Out of Scope).
- Real-time / live availability wiring — that is #34 (`availabilityStatus` stays
  `null` here).
- Role assignment (#27) and member removal (#28); leave
  `app/api/church-group/members/[id]/*` stubs untouched.
- New migrations — the schema and RLS policies already exist.
- Pagination, sorting, filtering, or search over the directory.
