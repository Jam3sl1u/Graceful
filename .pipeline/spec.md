# Spec — Issue #31: Instrument list management (default + custom)

## OPEN QUESTIONS
None are blocking. Two decisions were made explicitly below; if a human disagrees, only these change:
1. **Duplicate names** — the DB has NO unique constraint on `(church_group_id, name)`. This spec adds a case-insensitive duplicate guard at the handler layer (409 CONFLICT) for both insert paths, because duplicate instrument names break roster/list UX. If duplicates should be allowed, drop the guard.
2. **"pending" flag** — modeled as `pending = !is_default`. Admin `POST` and `promote` set `is_default = true`; member custom submissions are `is_default = false`. No new column is added (schema is frozen from #17).

## Current state (already in repo)
- All 5 route files exist but are `notImplemented` (501) stubs:
  - `app/api/instruments/route.ts` (GET, POST)
  - `app/api/instruments/custom/route.ts` (POST)
  - `app/api/instruments/[id]/route.ts` (DELETE)
  - `app/api/instruments/[id]/promote/route.ts` (POST)
- `schemas/instruments.ts` is an empty-object stub.
- Table `instruments` (migration `20260702000002_cluster_2_instruments.sql`):
  `id, church_group_id, name varchar(100), is_default bool default false, created_by uuid null (FK users.id on delete set null), created_at timestamptz default now()`.
- Table `member_instruments`: `id, member_profile_id, instrument_id` with FK `instrument_id → instruments.id ON DELETE CASCADE` and `unique(member_profile_id, instrument_id)`.
- RLS (`20260704000001_rls_policies.sql`): instruments SELECT/INSERT/UPDATE/DELETE are **tenant-scoped only** (`church_group_id = auth_church_group_id()`), NOT role-gated. Therefore **admin-only enforcement MUST happen in the handler** via `requireRole(ctx, ["admin"])`.
- Types: `lib/supabase/types.ts` already has `instruments` Row/Insert/Update. `InstrumentsRow` = `{ id, church_group_id, name, is_default, created_by, created_at }`; `Insert` marks `created_at` required even though the DB defaults it (same quirk handled in the profile handler with an `as unknown as ...Insert` cast). **No changes to this file.**
- `types/domain.ts`: `UserRole = "admin" | "set_leader" | "member" | "guest"`.
- `lib/api/errors.ts` already exports `ErrorCode.CONFLICT` and `ErrorCode.NOT_FOUND`.
- Next.js is `^15.3.0` → dynamic route `params` is a **Promise** and must be awaited.

## Files to create / modify

### 1. MODIFY `schemas/instruments.ts` (replace entire file)
Follow `schemas/profile.ts` style.
```ts
import { z } from "zod";

// Body for POST /api/instruments and POST /api/instruments/custom.
export const createInstrumentSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreateInstrumentInput = z.infer<typeof createInstrumentSchema>;
```

### 2. CREATE `app/api/instruments/handler.ts`
Single shared handler module (mirror `app/api/profile/handler.ts` structure: `requireAuth` → JWT → `getSupabaseClient` → query → `ok`/`fail`, wrapped in a single `try/catch` that maps `ApiException` to `fail`, else 500 INTERNAL). Export a response type and five handlers.

Response type + mapper:
```ts
export type InstrumentResponse = {
  id: string;
  name: string;
  isDefault: boolean;
  pending: boolean;   // = !isDefault
  createdBy: string | null;
};
// private
function toInstrumentResponse(row: { id: string; name: string; is_default: boolean; created_by: string | null }): InstrumentResponse
```

Handler signatures (pass `id` explicitly so unit tests can call handlers directly, matching how `profile`/`members` handlers are tested):
```ts
export async function listInstruments(req: NextRequest, lookup?: UserLookup): Promise<Response>            // any authenticated member
export async function addInstrument(req: NextRequest, lookup?: UserLookup): Promise<Response>              // admin only
export async function submitCustomInstrument(req: NextRequest, lookup?: UserLookup): Promise<Response>     // any member
export async function promoteInstrument(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>  // admin only
export async function deleteInstrument(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>   // admin only
```

Imports to copy from `app/api/profile/handler.ts`: `NextRequest`, `auth` from `@clerk/nextjs/server`, `requireAuth`, `requireRole`, `type UserLookup` from `@/lib/api/auth`, `ok`, `fail` from `@/lib/api/response`, `ApiException`, `ErrorCode` from `@/lib/api/errors`, `getSupabaseClient` from `@/lib/supabase/client`, `type Database` from `@/lib/supabase/types`, plus `createInstrumentSchema` from `@/schemas/instruments`.

Standard preamble in EVERY handler after `requireAuth` (and, where noted, `requireRole`):
```ts
const { getToken } = await auth();
const jwt = await getToken({ template: "supabase" });
if (!jwt) return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
const supabase = getSupabaseClient(jwt);
```

**`listInstruments`** — `requireAuth` only (no role gate). Query:
```ts
supabase.from("instruments")
  .select("id, name, is_default, created_by")
  .eq("church_group_id", ctx.churchGroupId)
  .order("is_default", { ascending: false })
  .order("name", { ascending: true })
```
On `error` → 500 INTERNAL. Return `ok({ instruments: (data ?? []).map(toInstrumentResponse) })` (empty array when none).

**`addInstrument`** (admin) — `requireAuth` then `requireRole(ctx, ["admin"])`. Parse body with `createInstrumentSchema.safeParse(await req.json().catch(() => null))` → 400 VALIDATION_FAILED on failure. Run duplicate guard (below) → 409 CONFLICT. Insert:
```ts
const payload = {
  church_group_id: ctx.churchGroupId,
  name: parsed.name,
  is_default: true,
  created_by: ctx.userId,
} as unknown as Database["public"]["Tables"]["instruments"]["Insert"];
supabase.from("instruments").insert(payload).select("id, name, is_default, created_by").single()
```
Do NOT set `created_at`. On `error`/no data → 500. Return `ok({ instrument: toInstrumentResponse(data) }, 201)`.

**`submitCustomInstrument`** — `requireAuth` only (any member; AC lets any member submit). Same body parse + duplicate guard. Insert identical to `addInstrument` EXCEPT `is_default: false`. Return `ok({ instrument }, 201)`.

**`promoteInstrument`** (admin) — `requireAuth` + `requireRole(ctx, ["admin"])`. Update:
```ts
supabase.from("instruments")
  .update({ is_default: true } as unknown as Database["public"]["Tables"]["instruments"]["Update"])
  .eq("id", id).eq("church_group_id", ctx.churchGroupId)
  .select("id, name, is_default, created_by")
```
If `error` → 500. If returned array is empty (no row matched) → 404 NOT_FOUND. Else `ok({ instrument: toInstrumentResponse(rows[0]) })`. (Promoting an already-default instrument is idempotent — still 200.)

**`deleteInstrument`** (admin) — `requireAuth` + `requireRole(ctx, ["admin"])`.
```ts
supabase.from("instruments").delete()
  .eq("id", id).eq("church_group_id", ctx.churchGroupId)
  .select("id")
```
If `error` → 500. If returned array empty → 404 NOT_FOUND. Else `ok({ deleted: true })`. (FK cascade auto-clears `member_instruments` — no extra work.)

**Duplicate guard helper** (used by `addInstrument` + `submitCustomInstrument`), run after body parse, before insert:
```ts
const { data: existing, error: dupErr } = await supabase
  .from("instruments").select("name").eq("church_group_id", ctx.churchGroupId);
if (dupErr) return fail("Internal error", ErrorCode.INTERNAL, 500);
if ((existing ?? []).some((r) => r.name.trim().toLowerCase() === parsed.name.toLowerCase()))
  return fail("Instrument already exists", ErrorCode.CONFLICT, 409);
```

**Catch block** (copy from profile handler): map `ApiException` → `fail(err.message, err.code, err.status)`, else `fail("Internal error", ErrorCode.INTERNAL, 500)`.

### 3. MODIFY `app/api/instruments/route.ts`
```ts
import { NextRequest } from "next/server";
import { listInstruments, addInstrument } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listInstruments(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return addInstrument(req);
}
```

### 4. MODIFY `app/api/instruments/custom/route.ts`
```ts
import { NextRequest } from "next/server";
import { submitCustomInstrument } from "../handler";

export async function POST(req: NextRequest): Promise<Response> {
  return submitCustomInstrument(req);
}
```

### 5. MODIFY `app/api/instruments/[id]/route.ts`
```ts
import { NextRequest } from "next/server";
import { deleteInstrument } from "../handler";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return deleteInstrument(req, id);
}
```

### 6. MODIFY `app/api/instruments/[id]/promote/route.ts`
```ts
import { NextRequest } from "next/server";
import { promoteInstrument } from "../../handler";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return promoteInstrument(req, id);
}
```

## Edge cases the implementation MUST handle
- Clerk user unauthenticated → 401 UNAUTHENTICATED (handled by `requireAuth`).
- Valid Clerk user but no Supabase JWT → 401 UNAUTHENTICATED (before touching Supabase).
- Non-admin calling `addInstrument` / `promoteInstrument` / `deleteInstrument` → 403 FORBIDDEN (via `requireRole`). `listInstruments` and `submitCustomInstrument` are open to any authenticated member.
- Malformed/missing body or empty/whitespace-only `name` → 400 VALIDATION_FAILED (`name` is `.trim().min(1)`).
- `name` longer than 100 chars → 400 (matches `varchar(100)`).
- Duplicate name (case-insensitive, same group) on either insert path → 409 CONFLICT.
- `promote`/`delete` with an id that doesn't exist OR belongs to another church group → 404 NOT_FOUND (the `.eq("church_group_id", ...)` scoping makes cross-tenant ids indistinguishable from missing — correct behavior).
- All queries scoped to `ctx.churchGroupId`; inserts set `church_group_id: ctx.churchGroupId` (required by the RLS INSERT check).
- Any Supabase `error` → 500 INTERNAL. `ApiException` from auth helpers → mapped via the shared catch block.
- Multiple members sharing an instrument is inherently supported (no exclusivity logic); do NOT add any uniqueness on member selection here. Deleting a shared instrument cascades to `member_instruments`.

## Tests
Create `tests/unit/app/api/instruments-route.test.ts`. Copy the mocking harness from `tests/unit/app/api/church-group-members-route.test.ts` / `profile-route.test.ts`:
- `jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }))` and `jest.mock("@/lib/supabase/client", ...)`.
- `makeLookup(role)` producing an `AuthContext`, `setUpAuth(jwt)`, and a `makeSupabaseClient(overrides)` fixture builder whose mocked `from(table)` supports the chains used here: `.select(...).eq(...).order(...).order(...)`, `.select(...).eq(...)` (duplicate-guard read), `.insert(...).select(...).single()`, `.update(...).eq(...).eq(...).select(...)`, `.delete().eq(...).eq(...).select(...)`.
Cover, mapping to acceptance criteria + edge cases: GET 200 list (ordered, `pending` flag correct for default vs custom rows) and GET 200 empty; POST admin 201 sets `is_default: true`; POST 403 for non-admin; POST 400 empty name; POST 409 duplicate (case-insensitive); custom POST 201 sets `is_default: false` and is allowed for a plain member; promote admin 200 + 404 when id missing + 403 non-admin; delete admin 200 `{ deleted: true }` + 404 missing + 403 non-admin; 401 when no JWT; 500 on DB error.

## Patterns to copy
- Handler shape, JWT/`requireAuth` flow, try/catch → `ApiException` mapping, and the `as unknown as ...Insert` cast: **`app/api/profile/handler.ts`**.
- Role gating: **`app/api/_examples/admin-only/handler.ts`** (`requireRole(ctx, ["admin"])`).
- Multi-select + name-map query style: **`app/api/church-group/members/handler.ts`**.
- Route → handler delegation: **`app/api/profile/route.ts`** and **`app/api/church-group/members/route.ts`**.
- Zod schema style: **`schemas/profile.ts`**.
- Unit test harness / Supabase mock: **`tests/unit/app/api/profile-route.test.ts`**.
- Response envelope: `ok`/`fail` from `lib/api/response.ts`; codes from `lib/api/errors.ts`.

## Out of scope (do NOT implement)
- Attaching instruments to a member profile / editing member selections (that is #30's `member_instruments`; this issue only manages the group's instrument catalog).
- Transposition logic (Phase 3).
- New DB migrations or schema changes — the schema from #17 is sufficient. Do NOT add columns or constraints, and do NOT edit `lib/supabase/types.ts`.
- Seeding the 9 defaults (done in #24).
