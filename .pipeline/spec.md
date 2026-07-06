# Spec — Issue #24: Church group creation (`PUT /api/church-group`)

## No blocking open questions
The prior instrument-count ambiguity was escalated and **decided by a human**:
seed **exactly the 8 named default instruments** (below) as `is_default = true`
rows. Do **NOT** seed a literal "Other" row. The AC's "9 default instruments"
wording refers to the UI's "Other" custom-entry affordance, not a real seeded
row. Users add further non-default instruments through the existing
instrument-creation path (`POST /api/instruments` / `POST /api/instruments/custom`,
both out of scope for this issue). This is settled — do not re-raise it.

The 8 default instrument names (exact strings, in this order):
`Acoustic guitar`, `Electric guitar`, `Bass guitar`, `Piano/keyboard`,
`Violin`, `Vocalists`, `Drums`, `Cajon`.

Non-blocking note (follow the issue, no decision needed): Issue #24 says
`PUT /api/church-group` **creates** a group. PRD §22.1 lists `PUT
/api/church-group` as an Admin route that **updates** name/timezone/denomination.
**This spec follows the issue: PUT creates.** A future update endpoint and `GET`
are out of scope here (leave `GET` as `notImplemented`).

---

## Background — why a SECURITY DEFINER RPC is required (read before coding)

The existing RLS model blocks every naive implementation:

- `church_groups` has RLS enabled with **only a SELECT policy** — no authenticated
  INSERT policy, so an authenticated client cannot `INSERT` a group
  (`supabase/migrations/20260704000002_church_groups_rls.sql`).
- `users` has **no INSERT policy** — "provisioning is service-role / webhook only"
  (`supabase/migrations/20260704000001_rls_policies.sql`, lines 76–77).
- `instruments` INSERT requires `church_group_id = auth_church_group_id()`, but a
  brand-new creator has no `users` row yet, so `auth_church_group_id()` is null.
- The Supabase **service-role key is forbidden** in `app/` and `lib/` — enforced by
  `scripts/check-service-role.mjs` (CI job `check:service-role`). Do NOT use it.
- `requireAuth` (`lib/api/auth.ts`) returns 401 when the Clerk user has no `users`
  row, so the standard `requireAuth` guard **cannot** be used on this route — the
  creator has no `users` row until this request completes.

**Therefore the entire creation runs as one atomic `SECURITY DEFINER` Postgres
function (RPC)**, called by the RLS-scoped anon client with the creator's Clerk
JWT. This mirrors the existing `SECURITY DEFINER` helpers in
`20260704000001_rls_policies.sql` (e.g. `auth_church_group_id()`). No service-role
key, no new authenticated INSERT policies.

---

## Files to create / modify

### 1. CREATE `supabase/migrations/20260706000001_church_group_create_rpc.sql`
New migration (timestamp must sort after the latest existing
`20260704000002_...`). Follow the UP / commented-DOWN structure and
`SECURITY DEFINER ... SET search_path = ''` + schema-qualification style used in
`20260704000001_rls_policies.sql`.

Contents:

**a) `public.generate_invite_code()` → `text`**
- `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = ''`.
- Generates an 8-character, URL-safe, unambiguous code. Alphabet:
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0/O/1/I/L`, all URL-safe).
- Loop: generate a candidate, `SELECT` against `public.church_groups.invite_code`;
  repeat until unique. Return the unique code. (Fits `varchar(20)`; matches the
  "8-char invite code" in PRD onboarding step 3a, line 1072.)

**b) `public.create_church_group(...)` → `public.church_groups`**
- `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = ''`, `VOLATILE`.
- Parameters (all schema-qualified types):
  - `p_name text`
  - `p_timezone text`
  - `p_denomination text` (nullable)
  - `p_logo_url text` (nullable)
  - `p_creator_name text`
  - `p_creator_email text` (nullable)
- Behavior, in order, in one transaction (function body is atomic):
  1. Resolve `v_clerk_id := auth.jwt() ->> 'sub'`. If null → `RAISE EXCEPTION`
     with `ERRCODE = 'P0001'`, message `'UNAUTHENTICATED'`.
  2. Guard: if a `public.users` row already exists for `v_clerk_id` →
     `RAISE EXCEPTION` `ERRCODE = 'P0001'`, message `'USER_ALREADY_IN_GROUP'`
     (a user may belong to only one group; prevents creating a second).
  3. `INSERT INTO public.church_groups (name, denomination, timezone, logo_url,
     invite_code)` using params + `public.generate_invite_code()`; `RETURNING *`
     into a `church_groups%ROWTYPE` variable.
  4. `INSERT INTO public.users (clerk_id, church_group_id, role, name, email)`
     with `role = 'admin'`, the new group id, `p_creator_name`, `p_creator_email`.
  5. Seed the 8 default instruments: `INSERT INTO public.instruments
     (church_group_id, name, is_default, created_by)` — one row per name in the
     8-name list above, `is_default = true`, `created_by = NULL` (platform seed).
     Use a hardcoded array literal of exactly those 8 names, in the given order.
     Do NOT insert an "Other" row or any 9th row.
  6. `RETURN` the church_groups row variable.
- `GRANT EXECUTE ON FUNCTION public.create_church_group(text, text, text, text,
  text, text) TO authenticated;`. Do NOT grant `generate_invite_code` to
  `authenticated` — it is only called internally under SECURITY DEFINER.
- Commented-out DOWN section dropping both functions.

### 2. MODIFY `schemas/church-group.ts`
Replace the empty `z.object({})` stub. Follow the plain-`zod` style already in the
repo (see `schemas/availability.ts`).

```ts
import { z } from "zod";

export const createChurchGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .refine(isValidIanaTimezone, { message: "Invalid IANA timezone" })
    .default("America/Chicago"),
  denomination: z.string().trim().max(100).optional(),
  logoUrl: z.string().trim().max(2048).optional(), // R2 object key, never a public URL
});

export type CreateChurchGroupInput = z.infer<typeof createChurchGroupSchema>;
```

- `isValidIanaTimezone(tz: string): boolean` — implement locally: return true iff
  `new Intl.DateTimeFormat("en-US", { timeZone: tz })` does not throw (wrap in
  try/catch). Do not hardcode a timezone list.
- `name` is the only required field; `timezone` defaults so a missing timezone is
  valid; `denomination`/`logoUrl` optional. A missing/blank `name` must fail
  validation (drives the 400 AC).
- The current `churchGroupSchema` / `ChurchGroupInput` exports are unused — remove
  them (replace with the new exports).

### 3. MODIFY `app/api/church-group/route.ts`
Keep `GET` as `notImplemented("GET /api/church-group")` (out of scope for #24).
Implement `PUT`. Pattern to copy for the try/catch + `ok`/`fail` envelope:
`app/api/_examples/admin-only/route.ts`. Pattern to copy for calling Supabase with
the Clerk JWT: `lib/api/auth.ts` (`lookupUserByClerkId` — `auth()`,
`getToken({ template: "supabase" })`, `getSupabaseClient(jwt)`).

`PUT` behavior:
1. `const { userId: clerkId, getToken } = await auth();` (from
   `@clerk/nextjs/server`). If `!clerkId` → `fail("Authentication required",
   ErrorCode.UNAUTHENTICATED, 401)`.
2. `const jwt = await getToken({ template: "supabase" });` If `!jwt` → 401.
3. Parse body: `const body = await req.json().catch(() => null);` then
   `createChurchGroupSchema.safeParse(body)`. On failure → `fail("Validation
   failed", ErrorCode.VALIDATION_FAILED, 400)`. (400 AC.)
4. Fetch creator identity from Clerk: `const user = await currentUser();`
   (from `@clerk/nextjs/server`). Derive:
   - `creatorName` = first non-empty of `user.fullName`, `${firstName} ${lastName}`
     trimmed, `username`, primary email local-part, else `"Admin"`. Must be
     non-empty (`users.name` is NOT NULL). Truncate to 100 chars.
   - `creatorEmail` = primary email address or `null`.
5. `const supabase = getSupabaseClient(jwt);`
6. `const { data, error } = await supabase.rpc("create_church_group", {
     p_name: parsed.name, p_timezone: parsed.timezone,
     p_denomination: parsed.denomination ?? null, p_logo_url: parsed.logoUrl ?? null,
     p_creator_name: creatorName, p_creator_email: creatorEmail });`
7. Error mapping:
   - `error.message` contains `USER_ALREADY_IN_GROUP` → `fail("User already
     belongs to a church group", ErrorCode.CONFLICT, 409)`.
   - `error.message` contains `UNAUTHENTICATED` → 401.
   - any other `error` → `fail("Internal error", ErrorCode.INTERNAL, 500)`.
8. Success → `ok(data, 201)` (201 Created). `data` is the new `church_groups` row
   (includes `invite_code`).

Do NOT call `requireAuth` here (see Background — creator has no `users` row yet).

### 4. MODIFY `lib/supabase/types.ts`
`church_groups` and `instruments` tables now exist, and the RPC must typecheck.
Add to `Database["public"]`, keeping the existing minimal hand-written style:
- A `church_groups` table entry with `Row` = `{ id: string; name: string;
  denomination: string | null; timezone: string; logo_url: string | null;
  invite_code: string; created_at: string; updated_at: string }`, plus matching
  `Insert`/`Update`/`Relationships: []` mirroring the existing `users` entry.
- Replace `Functions: Record<string, never>` with:
  ```ts
  Functions: {
    create_church_group: {
      Args: {
        p_name: string; p_timezone: string;
        p_denomination: string | null; p_logo_url: string | null;
        p_creator_name: string; p_creator_email: string | null;
      };
      Returns: ChurchGroupsRow; // the church_groups Row type
    };
  };
  ```
Keep the file otherwise minimal; do not add tables unrelated to this issue.

---

## Edge cases the implementation must handle
- Missing/blank `name` → 400 `VALIDATION_FAILED`.
- Body is not JSON / empty body → 400 (safeParse on `null`).
- Missing `timezone` → allowed, defaults to `America/Chicago`.
- Invalid IANA `timezone` (e.g. `"Mars/Phobos"`) → 400.
- Unauthenticated (no Clerk session or no supabase JWT) → 401.
- Caller already has a `users` row (already in a group) → 409 `CONFLICT`.
- Invite-code collision → handled transparently by the retry loop in
  `generate_invite_code()`; never surfaces to the client.
- `denomination` / `logoUrl` omitted → stored as SQL `NULL`.
- Creator has no name available from Clerk → fall back to `"Admin"` (never insert
  a null/empty `users.name`).
- Exactly 8 instrument rows seeded, all `is_default = true`; no "Other" row.

## Patterns to follow (name the file)
- Route try/catch + `ok`/`fail` envelope: `app/api/_examples/admin-only/route.ts`.
- Clerk JWT → Supabase client: `lib/api/auth.ts` (`lookupUserByClerkId`).
- Error codes / `ApiException`: `lib/api/errors.ts` (use `ErrorCode.CONFLICT`,
  `VALIDATION_FAILED`, `UNAUTHENTICATED`, `INTERNAL`).
- Migration style (`SECURITY DEFINER`, `SET search_path = ''`, UP/commented-DOWN):
  `supabase/migrations/20260704000001_rls_policies.sql`.
- Zod schema file style: `schemas/availability.ts` / other `schemas/*`.

## Tests the coder should add (tester will expand)
Unit test `tests/unit/app/api/church-group-route.test.ts`, following the mocking
style of `tests/unit/lib/api/lookup-user.test.ts` (mock `@clerk/nextjs/server` and
`@/lib/supabase/client`; stub `supabase.rpc`). Cover: 201 happy path (asserts
`rpc` called with correct params and response is the group incl. `invite_code`),
400 on missing `name`, 400 on invalid timezone, 401 when no Clerk userId, 409 when
rpc returns a `USER_ALREADY_IN_GROUP` error, 500 on generic rpc error.

DB behavior of the RPC (exactly 8 default instruments seeded, creator gets `admin`
role, unique invite code) is integration-tested under `tests/integration/rls/` —
out of scope for the unit route test.

## Explicitly out of scope
- Join-via-code flow (`POST /api/church-group/join`, issue #25).
- Group settings / onboarding UI screens.
- `GET` and update semantics for `PUT` per PRD §22 — leave `GET` as
  `notImplemented`.
- Clerk webhook user provisioning (`app/api/webhooks/clerk/route.ts` stays a stub).
- Adding non-default instruments (handled by the existing
  `POST /api/instruments` / `POST /api/instruments/custom` paths).
