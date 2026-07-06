# Spec — Issue #24: Implement church group creation

`PUT /api/church-group` creates a church group, assigns the creator as `admin`,
auto-generates a unique invite code, and seeds the 9 default instruments.

## OPEN QUESTIONS

None are blocking. Two decisions were made from repo/PRD evidence — implement as
written below:

1. **PUT = create (not update).** PRD §22.1 lists `PUT /api/church-group` as
   "update", but Issue #24 explicitly redefines it as the create endpoint. The
   issue wins. Update-group is out of scope for this issue.
2. **Creator's `name`/`email` come from Clerk, not the request body.**
   `users.name` is `NOT NULL`; the onboarding flow (PRD §21.1 steps 1→2b) creates
   the Clerk account first, then the `users` row. So the route reads `currentUser()`
   from Clerk for name/email. The request body carries only group fields.

## Key architectural constraint (read first)

The creator is a Clerk-authenticated user who has **no `users` row and no group yet**.
Therefore:

- **Do NOT use `requireAuth`** — it looks up the `users` table by `clerk_id` and
  would 401 a brand-new user. Use Clerk `auth()` directly for the `clerkId` + JWT.
- Writes to `church_groups`, `users`, and `instruments` are all **denied by RLS**
  for the `authenticated` role (church_groups has SELECT-only policy; users/instruments
  INSERT require `auth_church_group_id()`, which is null for a new user).
- **The service-role key is forbidden in `app/` and `lib/`** (guarded by
  `scripts/check-service-role.mjs`; `bun run check:service-role`). Do not import or
  reference it.
- **Resolution:** perform the entire creation inside a Postgres `SECURITY DEFINER`
  RPC (`public.create_church_group`), called via the RLS-scoped Supabase client with
  the caller's JWT. `SECURITY DEFINER` bypasses RLS inside the function, exactly like
  the existing `auth_*` helpers in `20260704000001_rls_policies.sql`. This keeps
  `church_groups` writes locked while still allowing the atomic bootstrap.

## Files to create / modify

### 1. CREATE `supabase/migrations/20260705000001_church_group_create_fn.sql`

New migration (timestamp is after the latest existing `20260704000002`). Follow the
`-- ============ UP ============` / commented `-- ============ DOWN ============`
convention used by every migration in `supabase/migrations/`. `pgcrypto` (for
`gen_random_bytes`) is already enabled by cluster 1.

Define `public.create_church_group` as
`LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''` with signature (all `text`
params; schema-qualify every table as `public.*`):

```
create or replace function public.create_church_group(
  p_name         text,
  p_timezone     text,
  p_denomination text,
  p_logo_url     text,
  p_user_name    text,
  p_user_email   text
) returns public.church_groups
```

Body requirements:

- `v_clerk_id := auth.jwt() ->> 'sub'`. If null →
  `raise exception 'not authenticated' using errcode = 'GR000';`
- **Already-a-member guard:** if a `public.users` row exists with
  `clerk_id = v_clerk_id`,
  `raise exception 'user already belongs to a church group' using errcode = 'GR001';`
- **Invite code:** generate an 8-character, URL-safe, unambiguous code and insert the
  `church_groups` row inside a `begin … exception when unique_violation then …` retry
  loop so an `invite_code` collision (the only unique constraint on the table) retries
  transparently. Alphabet must exclude ambiguous chars (`0/O/1/I/l`); use e.g.
  `23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz`. Build the code from
  `gen_random_bytes(1)` per character (crypto-random, not `random()`).
  Insert `(name, timezone, denomination, logo_url, invite_code)` and `returning *`
  into a `public.church_groups` variable.
- **Creator user row:** insert into `public.users`
  `(clerk_id, church_group_id, role, name, email)` with `role = 'admin'`,
  `name = p_user_name`, `email = p_user_email` (may be null). Capture the new
  `users.id` (via `returning id`) for `created_by` below.
- **Seed 9 default instruments:** insert 9 rows into `public.instruments`
  `(church_group_id, name, is_default, created_by)` with `is_default = true` and
  `created_by =` the new user id. Names exactly (PRD §11 instrument list):
  `Acoustic guitar`, `Electric guitar`, `Bass guitar`, `Piano / keyboard`, `Violin`,
  `Vocalists`, `Drums`, `Cajon`, `Other`.
- `return` the church_groups row variable.

After the function:
`grant execute on function public.create_church_group(text, text, text, text, text, text) to authenticated;`

Commented DOWN:
`drop function if exists public.create_church_group(text, text, text, text, text, text);`

### 2. MODIFY `schemas/church-group.ts`

Replace the empty `churchGroupSchema` stub. Add:

```
export const createChurchGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(50).default("America/Chicago"),
  denomination: z.string().trim().min(1).max(100).optional(),
  logo_url: z.string().trim().url().optional(),
});
export type CreateChurchGroupInput = z.infer<typeof createChurchGroupSchema>;
```

- `timezone` must be IANA. Add a `.refine(...)` that accepts the value when it is in
  `Intl.supportedValuesOf("timeZone")` (Node 22 supports this). Default is
  `America/Chicago` per PRD schema notes. On failure → validation error.
- Only `name`, `timezone`, `denomination?`, `logo_url?` are in scope. Do not invent
  extra fields. You may leave the old `churchGroupSchema`/`ChurchGroupInput` exports
  in place or remove them (nothing else imports them); the new create schema is what
  the route uses.

### 3. MODIFY `app/api/church-group/route.ts`

Leave `GET` as the existing `notImplemented("GET /api/church-group")` stub (GET is a
separate issue). Implement `PUT`:

Imports: `auth`, `currentUser` from `@clerk/nextjs/server`; `getSupabaseClient` from
`@/lib/supabase/client`; `ok`, `fail` from `@/lib/api/response`;
`ApiException`, `ErrorCode` from `@/lib/api/errors`; `createChurchGroupSchema` from
`@/schemas/church-group`.

Handler logic (wrap in `try/catch` mirroring `app/api/_examples/admin-only/route.ts`;
catch `ApiException` → `fail(err.message, err.code, err.status)`, else
`fail("Internal error", ErrorCode.INTERNAL, 500)`):

1. `const { userId: clerkId, getToken } = await auth();`
   If `!clerkId` → throw `ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
2. Parse body defensively: `const body = await req.json().catch(() => null);`
   `const parsed = createChurchGroupSchema.safeParse(body);`
   If `!parsed.success` → `return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
3. `const jwt = await getToken({ template: "supabase" });`
   If `!jwt` → throw `ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
4. `const user = await currentUser();` Derive:
   - `name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.username || "Admin";`
   - `email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? null;`
5. `const supabase = getSupabaseClient(jwt);`
   Call the RPC with snake_case param names matching the SQL function:
   ```
   const { data, error } = await supabase.rpc("create_church_group", {
     p_name: parsed.data.name,
     p_timezone: parsed.data.timezone,
     p_denomination: parsed.data.denomination ?? null,
     p_logo_url: parsed.data.logo_url ?? null,
     p_user_name: name,
     p_user_email: email,
   });
   ```
6. Error mapping:
   - `error?.code === "GR001"` → `return fail("You already belong to a church group", ErrorCode.CONFLICT, 409)`.
   - any other `error` → throw `ApiException("Internal error", ErrorCode.INTERNAL, 500)`.
7. Success → `return ok(data, 201);`

### 4. MODIFY `lib/supabase/types.ts`

Extend the hand-written `Database` type so the typed client + `.rpc(...)` compile
(keep `bun run typecheck` green). Add a `ChurchGroupsRow` type
(`id, name, denomination: string | null, timezone, logo_url: string | null,
invite_code, created_at, updated_at` — all `string` except the two nullables), add
`church_groups` and `instruments` entries under `Tables`, and replace the empty
`Functions: Record<string, never>` with:

```
Functions: {
  create_church_group: {
    Args: {
      p_name: string; p_timezone: string;
      p_denomination: string | null; p_logo_url: string | null;
      p_user_name: string; p_user_email: string | null;
    };
    Returns: ChurchGroupsRow;
  };
};
```

Do not remove the existing `users` table entry. Keep the file's "hand-written minimal"
intent — add only what these routes need.

### 5. MODIFY `supabase/README.md`

Add one row to the Migrations table for `20260705000001_church_group_create_fn.sql`
(Issue #24, "`create_church_group` SECURITY DEFINER bootstrap fn: group + admin user
+ 9 default instruments; invite-code generation"). Keeps docs in sync with the repo
convention.

## Edge cases the implementation must handle

- Missing/blank `name` → 400 `VALIDATION_FAILED`.
- Non-IANA `timezone` → 400 `VALIDATION_FAILED`. Omitted `timezone` → defaults to
  `America/Chicago`.
- `denomination` and `logo_url` omitted → group created with those columns null.
- Malformed/empty request body → 400 (do not throw on `req.json()`).
- No Clerk session (`clerkId` null) → 401 `UNAUTHENTICATED`.
- Missing Supabase JWT template → 401 `UNAUTHENTICATED`.
- Caller already has a `users` row (already in a group) → 409 `CONFLICT` (function
  raises `GR001`).
- `invite_code` collision → retried transparently inside the SQL function; never
  surfaces to the client.
- Any other DB/RPC error → 500 `INTERNAL`.
- The whole group + user + instruments write is atomic (single RPC / transaction):
  a failure leaves no partial group.

## Patterns to copy

- **Route structure & error handling:** `app/api/_examples/admin-only/route.ts`
  (try/catch → `ApiException` mapping via `fail`).
- **Clerk `auth()` + `getToken({ template: "supabase" })` + `getSupabaseClient`:**
  `lib/api/auth.ts` (`lookupUserByClerkId`).
- **SECURITY DEFINER function conventions** (`SET search_path = ''`, schema-qualified
  `public.*`, reading `auth.jwt() ->> 'sub'`): the `auth_*` helpers in
  `supabase/migrations/20260704000001_rls_policies.sql`.
- **Migration file format** (UP block + commented DOWN): any file in
  `supabase/migrations/`.
- **Response envelope:** `lib/api/response.ts` (`ok` / `fail`) and `lib/api/errors.ts`
  (`ErrorCode`, `ApiException`).

## Out of scope (do NOT build)

- `POST /api/church-group/join` (invite-code join flow — issue #25).
- Group settings / creation UI screen (functionality only).
- `GET /api/church-group` (leave as the `notImplemented` stub).
- Clerk custom-claim sync of `church_group_id`/`role` into the JWT (#5/#6).

## Notes for the tester (not implementation)

Unit tests will mock `@clerk/nextjs/server` (`auth`, `currentUser`) and
`@/lib/supabase/client` (`getSupabaseClient` returning an object with a `rpc` mock),
following `tests/unit/lib/api/lookup-user.test.ts` and
`tests/unit/app/api/admin-only-route.test.ts`. The RPC itself is covered by the RLS
integration suite against a live DB. `ErrorCode.CONFLICT` already exists in
`lib/api/errors.ts`; no new error codes are needed.
