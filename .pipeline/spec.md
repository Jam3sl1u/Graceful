# Spec — Issue #29: Audit log writer utility + read endpoint (BR-13)

## OPEN QUESTIONS

None blocking. One design decision was forced by the current RLS model and is
resolved below (see "Key constraint / chosen approach"). If a human disagrees
with that resolution, only the RPC migration would change.

---

## Scope

Deliver exactly two capabilities, nothing more:

1. A shared server-side `writeAuditLog()` utility any authenticated API route can call.
2. `GET /api/church-group/audit-log` — paginated, admin-only, read-only.

**Explicitly OUT OF SCOPE for this issue** (do NOT touch these files):

- Wiring `writeAuditLog()` into group creation (#24), role change (#27), member
  removal (#28), or any other route. Those are separate issues that will import
  this utility "as they're built." Leave the stubs at
  `app/api/church-group/members/[id]/role/route.ts` and
  `app/api/church-group/members/[id]/route.ts` untouched.
- Any audit-log UI/screen.
- Any UPDATE/DELETE path for audit rows (must not exist — already enforced at the
  DB layer by #21; see verification note in edge cases).

---

## Key constraint / chosen approach (read this first)

`audit_logs` already exists (migration `20260702000006_cluster6_auth_audit.sql`)
and is locked down:

- RLS SELECT policy `audit_logs_select_admin` — admin, same church group only.
- **No** `authenticated` INSERT policy. `UPDATE`/`DELETE` are `REVOKE`d from
  `authenticated`/`anon`. The RLS comment says inserts happen "via service role /
  triggers only."
- The service-role key is forbidden in `app/` and `lib/`, enforced by
  `scripts/check-service-role.mjs` (bun run `check:service-role`). So the utility
  **cannot** insert with a service-role client.

**Resolution:** insert through a `SECURITY DEFINER` RPC called by the normal
RLS-scoped anon client, exactly like `create_church_group` / `join_church_group`
(copy the structure of
`supabase/migrations/20260706000001_church_group_create_rpc.sql`). The RPC runs
as the table owner, which bypasses RLS for the INSERT while preserving the
append-only guarantee (it only ever INSERTs; UPDATE/DELETE stay revoked). This
keeps user-callable code free of the service-role key.

The RPC derives `user_id` and `church_group_id` from the caller's JWT (never from
caller-supplied arguments) so a route cannot forge a log entry attributed to
another user or group.

---

## Files to create

### 1. `supabase/migrations/20260707000001_audit_log_write_rpc.sql` (NEW)

Pattern to copy: `supabase/migrations/20260706000001_church_group_create_rpc.sql`
(same header-comment style, `SECURITY DEFINER`, `SET search_path = ''`, schema-
qualified names, `GRANT EXECUTE ... TO authenticated`, and a commented DOWN block).

Create `public.write_audit_log(...)`:

```sql
CREATE OR REPLACE FUNCTION public.write_audit_log(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_metadata    jsonb
)
  RETURNS public.audit_logs
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_user_id  uuid;
  v_group_id uuid;
  v_row      public.audit_logs%ROWTYPE;
BEGIN
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, church_group_id INTO v_user_id, v_group_id
  FROM public.users WHERE clerk_id = v_clerk_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.audit_logs
    (church_group_id, user_id, action, entity_type, entity_id, metadata)
  VALUES
    (v_group_id, v_user_id, p_action, p_entity_type, p_entity_id,
     COALESCE(p_metadata, '{}'::jsonb))
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.write_audit_log(text, text, uuid, jsonb) TO authenticated;
```

Include a commented `-- ============ DOWN ============` block dropping the
function, matching the sibling RPC migrations.

### 2. `lib/audit/write-audit-log.ts` (NEW)

Pattern to copy: the `SupabaseClient<Database>` typing + error-throwing style of
`loadInstruments` in `app/api/profile/handler.ts`. Must start with
`import "server-only";`.

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ApiException, ErrorCode } from "@/lib/api/errors";

// action uses dot-notation, e.g. "user.role_changed", "member.removed",
// "invitation.sent", "group.created". Free-form string (DB limit: 100 chars).
export type AuditLogEntry = {
  action: string;      // dot-notation; max 100 chars (DB varchar(100))
  entityType: string;  // e.g. "user", "invitation"; max 50 chars (DB varchar(50))
  entityId: string;    // uuid of the affected entity
  metadata?: Record<string, unknown>; // arbitrary JSON; defaults to {}
};

// Appends one immutable audit row for the caller's user + church group (both
// derived server-side from the JWT inside the write_audit_log RPC). `supabase`
// MUST be the RLS-scoped client for the acting user (getSupabaseClient(jwt)).
// Throws ApiException(INTERNAL, 500) on DB error; never swallows.
export async function writeAuditLog(
  supabase: SupabaseClient<Database>,
  entry: AuditLogEntry,
): Promise<void>;
```

Implementation notes:
- Call
  `supabase.rpc("write_audit_log", { p_action: entry.action, p_entity_type: entry.entityType, p_entity_id: entry.entityId, p_metadata: entry.metadata ?? {} })`.
- On `error`, throw `new ApiException("Internal error", ErrorCode.INTERNAL, 500)`.
  Return `void` on success (ignore returned row).
- Do NOT catch/swallow. Callers (future issues) decide whether a logging failure
  is fatal to their operation.

### 3. `schemas/audit-log.ts` (NEW)

Pattern to copy: `schemas/profile.ts`. Query-param schema (offset pagination):

```ts
import { z } from "zod";

export const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
```

### 4. `app/api/church-group/audit-log/handler.ts` (NEW)

Pattern to copy: `app/api/church-group/members/handler.ts` (auth → role gate →
JWT → RLS client → query → `ok(...)`, single `try/catch` mapping `ApiException` →
`fail`, else 500).

```ts
export type AuditLogItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  userId: string | null;   // nullable per schema (system actions)
  metadata: Record<string, unknown>;
  createdAt: string;       // ISO timestamp
};

export async function getAuditLog(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

Behavior:
1. `const ctx = await requireAuth(req, lookup);`
2. `requireRole(ctx, ["admin"]);` — admin only (defense in depth alongside RLS;
   yields 403 FORBIDDEN for non-admins instead of an empty list).
3. Parse query params from `req.nextUrl.searchParams` via `auditLogQuerySchema`
   (`.safeParse` on `Object.fromEntries(req.nextUrl.searchParams)`); on failure
   `return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);`
4. Get JWT (`const { getToken } = await auth();` → `getToken({ template: "supabase" })`);
   if null → `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);`
5. `const supabase = getSupabaseClient(jwt);`
6. Query with exact count + range:
   ```ts
   const from = (page - 1) * pageSize;
   const to = from + pageSize - 1;
   const { data, error, count } = await supabase
     .from("audit_logs")
     .select("id, action, entity_type, entity_id, user_id, metadata, created_at",
             { count: "exact" })
     .order("created_at", { ascending: false })
     .order("id", { ascending: false }) // stable tiebreak
     .range(from, to);
   ```
   RLS already scopes to the admin's own church group; adding
   `.eq("church_group_id", ctx.churchGroupId)` is acceptable/harmless but optional.
7. On `error` → `fail("Internal error", ErrorCode.INTERNAL, 500);`
8. Map rows (snake → camel) to `AuditLogItem[]`.
9. Respond:
   ```ts
   return ok({ entries, pagination: { page, pageSize, total: count ?? 0 } });
   ```
10. Wrap the whole body in the standard catch:
    ```ts
    } catch (err) {
      if (err instanceof ApiException) return fail(err.message, err.code, err.status);
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    ```

## Files to modify

### 5. `app/api/church-group/audit-log/route.ts` (REPLACE the stub)

Currently returns `notImplemented`. Replace with the thin delegator pattern from
`app/api/church-group/members/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAuditLog } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getAuditLog(req);
}
```

### 6. `lib/supabase/types.ts` (ADD types)

Follow the existing hand-written style. Needed so `typecheck` passes for both the
`.from("audit_logs")` select and the `.rpc("write_audit_log", ...)` call.

- Add row type:
  ```ts
  type AuditLogsRow = {
    id: string;
    church_group_id: string;
    user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    metadata: Record<string, unknown>;
    created_at: string;
  };
  ```
- Add to `Tables`:
  ```ts
  audit_logs: {
    Row: AuditLogsRow;
    Insert: Omit<AuditLogsRow, "id" | "created_at"> & { id?: string; created_at?: string };
    Update: Partial<AuditLogsRow>;
    Relationships: [];
  };
  ```
- Add to `Functions`:
  ```ts
  write_audit_log: {
    Args: {
      p_action: string;
      p_entity_type: string;
      p_entity_id: string;
      p_metadata: Record<string, unknown>;
    };
    Returns: AuditLogsRow;
  };
  ```

---

## Edge cases the implementation must handle

- **writeAuditLog with no metadata** → RPC receives `{}` (utility passes
  `entry.metadata ?? {}`; RPC also `COALESCE`s to `'{}'::jsonb`).
- **writeAuditLog RPC error** → throw `ApiException(INTERNAL, 500)`; never swallow.
- **Role-change metadata (AC 4)** → `metadata` must round-trip arbitrary JSON,
  e.g. `{ old_value: "member", new_value: "set_leader" }`. No special-casing; pass
  straight through to `p_metadata` (jsonb). This is what lets #27 satisfy its
  old→new requirement. Do NOT implement the role-change route here.
- **GET as non-admin (member/set_leader/guest)** → 403 FORBIDDEN.
- **GET unauthenticated / no `users` row** → 401 UNAUTHENTICATED (via `requireAuth`).
- **GET with no JWT from getToken** → 401 UNAUTHENTICATED (do not build a client).
- **GET invalid/negative page or pageSize > 100** → 400 VALIDATION_FAILED.
- **GET with zero matching rows** → 200 with `entries: []`, `pagination.total: 0`.
- **GET DB error** → 500 INTERNAL.
- **Ordering** → newest first (`created_at DESC`, `id DESC` tiebreak) for stable
  pagination.
- **No UPDATE/DELETE route** → confirm none is added. Append-only is already
  enforced at the DB layer (cluster-6 migration `REVOKE UPDATE, DELETE`); this
  issue must not add any handler exposing those verbs.

---

## Response shape (for the Tester)

Success (`200`):
```json
{
  "data": {
    "entries": [
      {
        "id": "uuid",
        "action": "user.role_changed",
        "entityType": "user",
        "entityId": "uuid",
        "userId": "uuid-or-null",
        "metadata": { "old_value": "member", "new_value": "set_leader" },
        "createdAt": "2026-07-07T00:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "pageSize": 50, "total": 1 }
  }
}
```
Errors use the standard `{ error, code }` envelope via `fail(...)`.

---

## Suggested test files (Tester will author)

Follow `tests/unit/app/api/profile-route.test.ts` for mocking style
(`jest.mock("@clerk/nextjs/server")`, `jest.mock("@/lib/supabase/client")`,
injected `UserLookup` via `makeLookup(role)`, chainable Supabase mock).

- `tests/unit/app/api/audit-log-route.test.ts` — admin 200 with mapped entries +
  pagination; non-admin 403; missing JWT 401; unauthenticated 401; invalid query
  params 400; DB error 500; empty result set. Note the GET reads params from
  `req.nextUrl.searchParams`, so the mocked `NextRequest` must expose `nextUrl`.
- `tests/unit/lib/audit/write-audit-log.test.ts` — asserts `rpc` invoked with
  correct `p_action/p_entity_type/p_entity_id/p_metadata` (incl. metadata default
  `{}`); throws `ApiException` INTERNAL on rpc error.

RLS admin-SELECT / append-only behavior is already covered by
`tests/integration/rls/rls.test.ts` and `.../tables/role-gated.test.ts` — do not
duplicate.

---

## Patterns to follow (name the file)

- SECURITY DEFINER RPC + grant + DOWN block: `supabase/migrations/20260706000001_church_group_create_rpc.sql`.
- Handler auth → role gate → JWT → RLS client → map → `ok`, with `try/catch`:
  `app/api/church-group/members/handler.ts`.
- Utility shape / `server-only` / throwing `ApiException`: `loadInstruments` in
  `app/api/profile/handler.ts`.
- Thin route delegation: `app/api/church-group/members/route.ts`.
- Zod schema style: `schemas/profile.ts`.
- Success/error envelope: `lib/api/response.ts` (`ok`, `fail`); shape in `types/api.ts`.
- Hand-written Supabase types (Tables + Functions): `lib/supabase/types.ts`.
- Unit test harness / Supabase mock: `tests/unit/app/api/profile-route.test.ts`.

---

## Commands (Bun)

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run check:service-role` (must stay green — proves no service-role key leaked)
