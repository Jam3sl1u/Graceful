# Spec — Issue #54: Draft setlist creation (BR-01 zero-song valid state)

## OPEN QUESTIONS

None. The only open point in the issue (Implementation Notes: "auto-create at
service-week creation vs. lazily here") is already resolved in the current
code and this spec keeps it consistent — see "Design decisions" below.

## Summary

Implement `GET` and `POST` for `/api/service-weeks/:id/setlist`. Both are
currently `notImplemented` (501) stubs. Everything else this issue needs
already exists and must NOT be rebuilt:

- DB table `setlists` with `service_week_id uuid not null unique`, `status
  setlist_status not null default 'draft'`, `church_group_id`, `published_at`,
  `notes`, `created_by`, timestamps
  (`supabase/migrations/20260702000003_cluster_3_scheduling_core.sql`).
- RLS policy `setlists_select_published_members`: members/guests can SELECT a
  setlist only when `status = 'published'`; leaders/admins see all statuses.
  Insert/update/delete restricted to leader/admin
  (`supabase/migrations/20260704000001_rls_policies.sql`, lines 160-181).
- A draft setlist is already auto-created when a service week is created
  (`app/api/service-weeks/handler.ts` `createServiceWeek`, lines 144-158).

So NO migration and NO change to `createServiceWeek` is required.

## Design decisions (do not deviate)

1. Auto-creation stays at service-week creation (already done). The `POST`
   endpoint here is a **get-or-create safety net**: it returns the existing
   setlist if one exists, otherwise creates a fresh draft. This keeps the
   "one setlist per week" invariant consistent with the unique constraint and
   the existing auto-create path.
2. "Members/Guests only see it once published" is enforced primarily by RLS
   on the JWT-scoped Supabase client — a member/guest querying a draft gets no
   row back, so the handler returns 404 (never leak existence via 403). Guests
   additionally must have an invitation for the week (mirror `getServiceWeek`).
3. Zero songs is valid: never validate song count anywhere. `POST` reads no
   request body and requires none.

## Files to change

### 1. `app/api/service-weeks/[id]/setlist/handler.ts` (CREATE)

New file. Copy structure/imports/error handling from
`app/api/service-weeks/[id]/handler.ts` (`getServiceWeek`). Same imports:
`auth` from `@clerk/nextjs/server`; `requireAuth`, `requireRole`, `UserLookup`
from `@/lib/api/auth`; `ok`, `fail` from `@/lib/api/response`; `ApiException`,
`ErrorCode` from `@/lib/api/errors`; `getSupabaseClient` from
`@/lib/supabase/client`; `Database` from `@/lib/supabase/types`.

Response mapper and type:

```ts
type SetlistsRow = Database["public"]["Tables"]["setlists"]["Row"];

export type SetlistResponse = {
  id: string;
  serviceWeekId: string;
  status: "draft" | "published";
  publishedAt: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toSetlistResponse(row: SetlistsRow): SetlistResponse {
  return {
    id: row.id,
    serviceWeekId: row.service_week_id,
    status: row.status,
    publishedAt: row.published_at,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Do NOT include a songs array — songs are out of scope (#55).

#### `getSetlist(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>`

`id` is the service-week id. Flow (wrap all in try/catch that maps
`ApiException` -> `fail(err.message, err.code, err.status)`, else 500 INTERNAL,
exactly like the existing handler):

1. `const ctx = await requireAuth(req, lookup);` (any authenticated role — no
   `requireRole`).
2. Get supabase JWT via `auth()` + `getToken({ template: "supabase" })`; if
   falsy -> `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
   Build `getSupabaseClient(jwt)`.
3. Query the setlist:
   `supabase.from("setlists").select("*").eq("service_week_id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`.
   RLS filters out drafts for members/guests automatically.
   - `error` -> 500 INTERNAL.
   - `!data` -> 404 NOT_FOUND (`fail("Not found", ErrorCode.NOT_FOUND, 404)`).
4. If `ctx.role === "guest"`: verify an invitation exists for this week —
   `supabase.from("invitations").select("id").eq("service_week_id", id).eq("user_id", ctx.userId).maybeSingle()`.
   Mirror `getServiceWeek` lines 43-57: `error` -> 500; no invitation -> 404
   NOT_FOUND (not 403).
5. Return `ok({ setlist: toSetlistResponse(data) })`.

#### `createSetlist(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>`

`id` is the service-week id. Flow:

1. `const ctx = await requireAuth(req, lookup);` then
   `requireRole(ctx, ["admin", "set_leader"]);` (throws `ApiException` 403
   FORBIDDEN for member/guest — caught by the try/catch).
2. JWT + supabase client (same as above; 401 if no JWT).
3. **Tenant-scoped week existence check (security-required, not optional):**
   `supabase.from("service_weeks").select("id").eq("id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`.
   - `error` -> 500 INTERNAL.
   - `!data` -> 404 NOT_FOUND. This prevents creating a setlist that points at
     another tenant's / a nonexistent week.
4. **Get-or-create:** query existing setlist
   `supabase.from("setlists").select("*").eq("service_week_id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`
   (leader/admin RLS sees drafts too).
   - `error` -> 500 INTERNAL.
   - if `data` -> return `ok({ setlist: toSetlistResponse(data) })` with status
     **200** (idempotent; already exists).
5. Insert a new draft:
   ```ts
   const insertPayload = {
     church_group_id: ctx.churchGroupId,
     service_week_id: id,
     created_by: ctx.userId,
   } as unknown as Database["public"]["Tables"]["setlists"]["Insert"];
   ```
   (Narrow cast mirrors `createServiceWeek`; `status` defaults to `'draft'`
   in the DB — do not set it.) Then
   `.insert(insertPayload).select("*").maybeSingle()`.
   - `error || !data` -> 500 INTERNAL (also covers a unique-constraint race).
6. Return `ok({ setlist: toSetlistResponse(created) }, 201)`.

Do NOT read or validate `req.json()` — no body is expected.

### 2. `app/api/service-weeks/[id]/setlist/route.ts` (REWRITE)

Replace the two `notImplemented` stubs. Follow the `Ctx` params pattern from
`app/api/service-weeks/[id]/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getSetlist, createSetlist } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getSetlist(req, id);
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return createSetlist(req, id);
}
```

### 3. `tests/unit/app/api/service-weeks-setlist-route.test.ts` (CREATE)

Mirror `tests/unit/app/api/service-weeks-id-route.test.ts` exactly for the
mocking harness (`jest.mock` of `@clerk/nextjs/server` and
`@/lib/supabase/client`, `makeChain`/`makeSupabaseClient`/`makeLookup`/
`setUpAuth` helpers, `makeReq`). Note: the chainable mock must support
`.select().eq().eq().maybeSingle()` and
`.insert().select().maybeSingle()` — extend `makeChain` with an `insert`
returning the chain if needed, and have the `from` mock expose `insert`.

Import the handlers under test from
`@/app/api/service-weeks/[id]/setlist/handler`.

Required cases (at minimum):

`getSetlist`:
- 401 UNAUTHENTICATED when Clerk `userId` is null (lookup never consulted).
- 401 UNAUTHENTICATED when `getToken` yields no JWT.
- 200 for a member when a published setlist row is returned; body
  `data.setlist` matches the mapped shape (`serviceWeekId`, `status`, etc.).
- 404 NOT_FOUND when the setlist query returns `{ data: null }` (this is the
  member-sees-draft-as-absent / week-has-no-setlist case).
- 200 for a guest WITH a matching invitation.
- 404 NOT_FOUND (not 403) for a guest with no invitation.
- 500 INTERNAL when the setlist query errors.

`createSetlist`:
- 403 FORBIDDEN for a member and for a guest (supabase never constructed).
- 401 cases as above.
- 404 NOT_FOUND when the tenant-scoped service_weeks lookup returns null.
- 200 returning the existing setlist when one already exists (assert status 200
  and that no insert row was created).
- 201 creating a new draft when none exists (assert status 201, `status` is
  `'draft'`, captured insert payload contains `church_group_id`,
  `service_week_id`, `created_by`).
- 500 INTERNAL when the insert errors.

## Edge cases the implementation must handle

- Zero-song setlist is fully valid (BR-01): no song validation anywhere; `POST`
  needs no body.
- One setlist per week: enforced by the DB unique constraint AND the
  get-or-create logic (existing -> 200, not a duplicate insert / not a 409).
- Members/guests must not see a draft setlist and must not learn it exists ->
  404, never 403 (RLS returns no row; handler maps null -> 404).
- Guests without an invitation for the week -> 404 (mirror `getServiceWeek`).
- Cross-tenant / nonexistent week id on `POST` -> 404 before any insert.
- Supabase query/insert errors -> 500 INTERNAL with `ErrorCode.INTERNAL`.

## Verify before finishing (coder)

`bun run lint`, `bun run typecheck`, and
`bun run test tests/unit/app/api/service-weeks-setlist-route.test.ts` (Jest via
`bun run test`, never bare `bun test`).
