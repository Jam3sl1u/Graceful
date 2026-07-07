# Spec — Issue #25: Join church group via invite code

## OPEN QUESTIONS (non-blocking; proceed with the stated assumption)

1. **"Expired" codes have no schema support.** `church_groups.invite_code` (migration `20260702000001_cluster_1_organization.sql`) is a plain `varchar(20) unique` with no expiry/TTL column. There is no concept of an expired code in the current data model, and adding one is out of scope for this issue. **Assumption:** treat only *unknown* codes as the failure case; return a 400 whose message reads "Invalid or expired invite code" so the copy still matches AC #2. Do NOT add an expiry column.

2. **Redirect target for "profile completion".** There is no dedicated instruments/vocal-capability onboarding form yet — that is issue #30. The only existing profile route is `/profile` (`app/(app)/profile/page.tsx`). **Assumption:** on a successful join the client redirects to `/profile`. If a human wants a distinct onboarding route, that is a #30 concern.

Neither question blocks implementation.

---

## Current state (already in the repo)

- `app/api/church-group/join/route.ts` — a stub: `POST` returns `notImplemented(...)` (501). Must be replaced.
- `app/(public)/join/[code]/page.tsx` — a stub server component ("coming soon"). Must be replaced with the client join flow.
- `schemas/church-group.ts` — has `createChurchGroupSchema`; no join schema yet.
- `lib/supabase/types.ts` — `Database.public.Functions` has `create_church_group` only.
- The invite-code + creation RPC pattern already exists in `supabase/migrations/20260706000001_church_group_create_rpc.sql` and route `app/api/church-group/route.ts` (`PUT`). **Copy these patterns exactly.**

---

## 1. Migration — CREATE

**File:** `supabase/migrations/20260706000002_church_group_join_rpc.sql`

**Pattern to copy:** `supabase/migrations/20260706000001_church_group_create_rpc.sql` (same `SECURITY DEFINER`, `SET search_path = ''`, `RAISE EXCEPTION ... USING ERRCODE = 'P0001'`, and `GRANT EXECUTE ... TO authenticated` conventions).

Add one function:

```sql
CREATE OR REPLACE FUNCTION public.join_church_group(
  p_invite_code text,
  p_member_name text,
  p_member_email text
)
  RETURNS public.users
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_group_id uuid;
  v_user public.users%ROWTYPE;
BEGIN
  -- 1. auth
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 2. reject users already in a group (users.clerk_id is unique)
  IF EXISTS (SELECT 1 FROM public.users WHERE clerk_id = v_clerk_id) THEN
    RAISE EXCEPTION 'USER_ALREADY_IN_GROUP' USING ERRCODE = 'P0001';
  END IF;

  -- 3. resolve the group from the invite code
  SELECT id INTO v_group_id
  FROM public.church_groups
  WHERE invite_code = p_invite_code;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_INVITE_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- 4. provision the member
  INSERT INTO public.users (clerk_id, church_group_id, role, name, email)
  VALUES (v_clerk_id, v_group_id, 'member', p_member_name, p_member_email)
  RETURNING * INTO v_user;

  RETURN v_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_church_group(text, text, text) TO authenticated;
```

- Include a commented `-- ============ DOWN ============` block with `DROP FUNCTION IF EXISTS public.join_church_group(text, text, text);` mirroring the create migration.
- Do NOT seed instruments (that is admin/creation-only). Do NOT create a `member_profiles` row (that is #30 territory).
- Runs `SECURITY DEFINER` for the same reason as create: the joiner has no `users` row yet, so `requireAuth` and the authenticated INSERT policies do not apply.

**Invite-code matching is exact/case-sensitive.** `generate_invite_code()` emits only uppercase `A–Z` (minus `0/O/1/I/L`) and `2–9`. The API layer normalizes input to uppercase (see §2), so the DB comparison stays a plain `=`.

---

## 2. Schema — MODIFY

**File:** `schemas/church-group.ts` (append; do not touch `createChurchGroupSchema`).

```ts
export const joinChurchGroupSchema = z.object({
  inviteCode: z.string().trim().toUpperCase().min(1).max(20),
});

export type JoinChurchGroupInput = z.infer<typeof joinChurchGroupSchema>;
```

- `.toUpperCase()` normalizes user-typed lowercase codes to match the stored uppercase codes.
- Keep `max(20)` aligned to the `varchar(20)` column. A well-formed but unknown code surfaces as 400 (`VALIDATION_FAILED`) from the RPC mapping in §3.

---

## 3. Route — REPLACE

**File:** `app/api/church-group/join/route.ts` (replace the stub entirely).

**Pattern to copy:** the `PUT` handler in `app/api/church-group/route.ts` — same auth flow, same `getSupabaseClient(jwt).rpc(...)` call, same try/catch → `INTERNAL` 500, same `deriveCreatorName` helper (rename to `deriveMemberName`, fallback string `"Member"` instead of `"Admin"`).

Signature:

```ts
export async function POST(req: NextRequest): Promise<Response>
```

Flow (in order):
1. `const { userId: clerkId, getToken } = await auth();` → if no `clerkId`, `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
2. `const jwt = await getToken({ template: "supabase" });` → if falsy, same 401.
3. `const body = await req.json().catch(() => null);` then `joinChurchGroupSchema.safeParse(body)` → on failure `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)` (do not call `getSupabaseClient`).
4. `const user = await currentUser();` → derive `p_member_name` via `deriveMemberName(user)` and `p_member_email = user?.primaryEmailAddress?.emailAddress ?? null`.
5. `const supabase = getSupabaseClient(jwt);` then:
   ```ts
   const { data, error } = await supabase.rpc("join_church_group", {
     p_invite_code: parsed.inviteCode,
     p_member_name: memberName,
     p_member_email: memberEmail,
   });
   ```
6. On `error`, map by `error.message.includes(...)`:
   - `"INVALID_INVITE_CODE"` → `fail("Invalid or expired invite code", ErrorCode.VALIDATION_FAILED, 400)`
   - `"USER_ALREADY_IN_GROUP"` → `fail("User already belongs to a church group", ErrorCode.CONFLICT, 409)`
   - `"UNAUTHENTICATED"` → `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`
   - else → `fail("Internal error", ErrorCode.INTERNAL, 500)`
7. On success: `return ok(data, 201);` (`data` is the new `users` row incl. `church_group_id` and `role: "member"`).
8. Wrap the whole body in `try { ... } catch { return fail("Internal error", ErrorCode.INTERNAL, 500); }` exactly like the `PUT` handler.

`deriveMemberName` — copy `deriveCreatorName` from `app/api/church-group/route.ts` verbatim, changing only the fallback literal `"Admin"` → `"Member"`.

---

## 4. Supabase types — MODIFY

**File:** `lib/supabase/types.ts`

Add a `join_church_group` entry to `Database.public.Functions` (alongside `create_church_group`) so the `.rpc()` call type-checks:

```ts
join_church_group: {
  Args: {
    p_invite_code: string;
    p_member_name: string;
    p_member_email: string | null;
  };
  Returns: UsersRow;
};
```

(`UsersRow` already exists in this file. `bun run typecheck` must stay green.)

---

## 5. Client join page — REPLACE

**File:** `app/(public)/join/[code]/page.tsx` (replace the stub).

Purpose: satisfy AC #4 (redirect into profile completion after joining). Keep it minimal.

- Convert to a flow that reads the `code` route param and, on submit, `POST`s `{ inviteCode: code }` to `/api/church-group/join`.
- Use a Client Component (`"use client"`) for the interactive/redirect part. A thin server component may unwrap `params` (which is `Promise<{ code: string }>`) and pass `code` to the client component — follow the existing param-unwrapping shape in the current stub.
- On a `2xx` response: redirect to `/profile` via `useRouter().push("/profile")` from `next/navigation` (the "profile completion" destination per OPEN QUESTION #2).
- On a non-2xx response: render the returned `error` string (from the `{ error, code }` envelope) as visible text. A 400 must show a clear "invalid/expired code" message to the user (AC #2).
- Do not build instrument/vocal-capability fields here — that is #30.
- Keep styling minimal/consistent with existing pages (inline styles like `app/(app)/profile/page.tsx` are acceptable; no new component library).

---

## 6. Unit tests — CREATE

**File:** `tests/unit/app/api/church-group-join-route.test.ts`

**Pattern to copy:** `tests/unit/app/api/church-group-route.test.ts` (same mocking of `@clerk/nextjs/server` and `@/lib/supabase/client`, same `makeReq` / `makeSupabaseRpc` helpers, same import style). Import `{ POST }` from `@/app/api/church-group/join/route`.

Required cases:
- **201 happy path** — valid code; asserts `rpc` called with `"join_church_group"` and `{ p_invite_code: "ABCD2345", p_member_name, p_member_email }`; response body is `{ data: <users row> }`; status 201.
- **inviteCode is uppercased/trimmed** — send `{ inviteCode: " abcd2345 " }`, assert `p_invite_code: "ABCD2345"`.
- **400 INVALID_INVITE_CODE** — rpc returns `error: { message: "INVALID_INVITE_CODE" }`; status 400, `body.code === "VALIDATION_FAILED"`.
- **400 on missing/empty inviteCode** — schema failure; status 400, `VALIDATION_FAILED`, `getSupabaseClient` NOT called.
- **400 on non-JSON/empty body** — `req.json()` rejects; status 400, `VALIDATION_FAILED`, `getSupabaseClient` NOT called.
- **409 USER_ALREADY_IN_GROUP** — rpc error message includes it; status 409, `CONFLICT`.
- **401 when no Clerk userId** — status 401, `UNAUTHENTICATED`, `getSupabaseClient` NOT called.
- **401 when getToken returns no JWT** — status 401, `UNAUTHENTICATED`, `getSupabaseClient` NOT called.
- **500 on generic rpc error** — rpc error `"connection refused"`; status 500, `INTERNAL`.
- **500 when currentUser rejects** — status 500, `INTERNAL`, `getSupabaseClient` NOT called (mirrors the create test's unexpected-error case).
- **falls back to "Member"** when `currentUser()` resolves `null` — assert `p_member_name: "Member"`, `p_member_email: null`.

---

## Out of scope (do not implement)

- Direct email invites (explicitly deferred by the issue).
- Invite-code expiry/TTL.
- `member_profiles` creation and the instruments/vocal-capability form (issue #30).
- Any change to `createChurchGroupSchema`, the create RPC, or the create route.

## Verification

- `bun run typecheck`, `bun run lint`, and `bun run test` must all pass.
- The migration is plain SQL; it is not executed by the test suite but must be valid and follow the `20260706000001_*` conventions.
