# Spec — Issue #37: Service Week CRUD

Implements `POST /api/service-weeks`, `GET /api/service-weeks`, `GET /api/service-weeks/:id`,
`PUT /api/service-weeks/:id`. Scope is CRUD only. `DELETE`, `/cancel`, `/reactivate`,
setlist song editing, and event creation are OTHER issues (#38/#39/#54/#59) — leave their
route stubs untouched.

The Cluster 3 schema (`service_weeks`, `setlists`, `invitations`) and the tenant RLS policies
already exist and are applied. No new migration is needed for this issue.

---

## OPEN QUESTIONS

### 1. Chat room placeholder is NOT buildable — defer it (recommended, non-blocking)

The issue says "Creating a week should auto-create a draft setlist **and an inactive chat room
placeholder** per Flow 4." There is **no `chat_rooms` table** — `supabase/migrations/20260702000005_cluster_5_partial.sql`
explicitly defers `chat_rooms`/`chat_messages`/`chat_mentions` to Phase 2 (see its header comment).
The issue itself notes "chat activation itself is Phase 2."

**Decision taken in this spec:** On week creation, auto-create the **draft setlist only**. Do
**not** attempt any chat-room write (the table does not exist; it would not compile/run). This is
tracked as a Phase 2 follow-up. If a human wants the chat room now, they must first land the
Phase 2 chat schema — out of scope here.

### 2. Required vs optional fields — follow the issue AC (all five required)

The issue AC states the five fields are "all required fields validated". The DB columns
(`title`, `sermon_topic`, `sermon_scripture`, `speaker_name`) are nullable and PRD Flow 4 §21.4
calls sermon topic/scripture "optional". **Decision taken in this spec:** follow the issue AC
literally — the create schema requires all five as non-empty. This is the authoritative
instruction for this task. (Noted only so a reviewer knows it was deliberate, not an oversight.)

---

## Patterns to copy

- Handler structure, auth, JWT fetch, error envelope: **copy `app/api/profile/handler.ts`**.
- Route → handler delegation: **copy `app/api/profile/route.ts`**.
- Role gating: `requireRole(ctx, [...])` from `lib/api/auth.ts` (see `app/api/church-group/members/handler.ts`).
- Insert type cast for the `created_at`-required hand-rolled Insert types:
  copy the `as unknown as Database["public"]["Tables"][...]["Insert"]` cast used in
  `app/api/profile/handler.ts` `updateProfile` (lines 90-99).
- Zod schema file: **copy the style of `schemas/profile.ts`**.
- Unit test structure and Supabase mock: **copy `tests/unit/app/api/profile-route.test.ts`**.

Envelope: success `{ data: ... }` via `ok(...)`; error `{ error, code }` via `fail(...)`.
Error codes from `lib/api/errors.ts`. All handlers wrap in try/catch and map `ApiException`
to `fail(err.message, err.code, err.status)`, else `fail("Internal error", INTERNAL, 500)`.

---

## Files to modify / create

### 1. `schemas/service-weeks.ts` — REPLACE the placeholder

Replace the empty `serviceWeeksSchema` with two schemas. Use `z` from `zod`.

```ts
export const createServiceWeekSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  title: z.string().trim().min(1).max(100),
  sermonTopic: z.string().trim().min(1),
  sermonScripture: z.string().trim().min(1),
  speakerName: z.string().trim().min(1).max(100),
});
export type CreateServiceWeekInput = z.infer<typeof createServiceWeekSchema>;

// PUT: same fields, all optional; at least one must be present.
export const updateServiceWeekSchema = z
  .object({
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    title: z.string().trim().min(1).max(100).optional(),
    sermonTopic: z.string().trim().min(1).optional(),
    sermonScripture: z.string().trim().min(1).optional(),
    speakerName: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field required");
export type UpdateServiceWeekInput = z.infer<typeof updateServiceWeekSchema>;
```

Keep the request body camelCase; map to snake_case DB columns in the handler.

### 2. `lib/supabase/types.ts` — ADD three tables

The file is hand-written (Cluster 1 only). Add `service_weeks`, `setlists`, and `invitations`
to `Database["public"]["Tables"]`, following the existing `Row`/`Insert`/`Update`/`Relationships`
shape. Import `SetlistStatus` (and `InvitationStatus`) from `@/types/domain`.

`ServiceWeeksRow`:
```ts
{
  id: string;
  church_group_id: string;
  service_date: string;
  title: string | null;
  sermon_topic: string | null;
  sermon_scripture: string | null;
  speaker_name: string | null;
  notes: string | null;
  is_cancelled: boolean;
  created_by: string | null;
  created_at: string;
}
```
- `Insert: Omit<ServiceWeeksRow, "id" | "created_at" | "is_cancelled"> & { id?: string; created_at?: string; is_cancelled?: boolean }`
- `Update: Partial<ServiceWeeksRow>`

`SetlistsRow`:
```ts
{
  id: string;
  church_group_id: string;
  service_week_id: string;
  status: SetlistStatus;
  published_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
```
- `Insert: Omit<SetlistsRow, "id" | "created_at" | "updated_at" | "status" | "published_at" | "notes"> & { id?: string; created_at?: string; updated_at?: string; status?: SetlistStatus; published_at?: string | null; notes?: string | null }`
- `Update: Partial<SetlistsRow>`

`InvitationsRow` (only the columns queried for guest scoping are load-bearing; include these):
```ts
{
  id: string;
  church_group_id: string;
  service_week_id: string;
  user_id: string;
  status: InvitationStatus;
  created_at: string;
}
```
- `Insert: Omit<InvitationsRow, "id" | "created_at"> & { id?: string; created_at?: string }`
- `Update: Partial<InvitationsRow>`
- All three tables: `Relationships: []`

Run `bun run typecheck` — it must stay green.

### 3. `app/api/service-weeks/handler.ts` — CREATE (list + create)

Export a shared response type and two handlers.

```ts
export type ServiceWeekResponse = {
  id: string;
  serviceDate: string;      // service_date
  title: string | null;
  sermonTopic: string | null;
  sermonScripture: string | null;
  speakerName: string | null;
  notes: string | null;
  isCancelled: boolean;     // is_cancelled
  createdBy: string | null; // created_by
  createdAt: string;        // created_at
};

export async function listServiceWeeks(req: NextRequest, lookup?: UserLookup): Promise<Response>;
export async function createServiceWeek(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

Add and **export** `toServiceWeekResponse(row: ServiceWeeksRow): ServiceWeekResponse` (snake → camel);
import it in `[id]/handler.ts` to avoid duplication.

**`listServiceWeeks` (GET /api/service-weeks) — Auth: any authenticated member of the group.**
1. `ctx = await requireAuth(req, lookup)`.
2. Fetch JWT (`auth()` → `getToken({ template: "supabase" })`); 401 `UNAUTHENTICATED` if missing.
   `supabase = getSupabaseClient(jwt)`.
3. Query `service_weeks` scoped `church_group_id = ctx.churchGroupId`, ordered `service_date` desc.
   (RLS already enforces the tenant scope; keep the explicit `.eq` too, matching the members handler.)
4. **Guest scoping:** if `ctx.role === "guest"`, restrict to weeks the guest is invited to.
   Query `invitations` for `user_id = ctx.userId` (RLS scopes to the tenant), collect the set of
   `service_week_id`, and filter the returned rows to that set (or add `.in("id", ids)`).
   If the guest has zero invitations, return `{ data: { serviceWeeks: [] } }`.
5. On any query `error` → 500 `INTERNAL`.
6. Return `ok({ serviceWeeks: rows.map(toServiceWeekResponse) })` (200).

**`createServiceWeek` (POST /api/service-weeks) — Auth: set_leader / admin only.**
1. `ctx = await requireAuth(req, lookup)`; then `requireRole(ctx, ["admin", "set_leader"])`
   (throws `ApiException` FORBIDDEN 403 — caught by the wrapper).
2. Parse body: `const body = await req.json().catch(() => null)`; `createServiceWeekSchema.safeParse`.
   On failure → 400 `VALIDATION_FAILED`.
3. Fetch JWT / supabase as above (401 if no JWT).
4. Insert into `service_weeks`:
   - `church_group_id: ctx.churchGroupId`
   - `service_date: parsed.serviceDate`
   - `title`, `sermon_topic`, `sermon_scripture`, `speaker_name` from parsed
   - `created_by: ctx.userId`
   - Do NOT set `id`, `created_at`, `is_cancelled`, `notes` (DB defaults / nullable).
   Use the `as unknown as Database[...]["service_weeks"]["Insert"]` cast pattern from the profile
   handler. `.select(...).maybeSingle()` to get the created row. On `error || !data` → 500 `INTERNAL`.
5. **Auto-create the draft setlist** for the new week: insert into `setlists`:
   - `church_group_id: ctx.churchGroupId`
   - `service_week_id: <new week id>`
   - `created_by: ctx.userId`
   - Do NOT set `status` (DB default `'draft'`) or `id`/timestamps.
   On error → 500 `INTERNAL`. Because `setlists.service_week_id` is `unique`, this must run after
   the week insert succeeds. Two sequential inserts (not a transaction) is acceptable — there is no
   RPC in scope. If the setlist insert fails, return 500; the orphaned week is an accepted edge here.
6. **Do NOT create a chat room** (see OPEN QUESTION 1).
7. Return `ok({ serviceWeek: toServiceWeekResponse(row) }, 201)`.

### 4. `app/api/service-weeks/route.ts` — REWRITE to delegate

Mirror `app/api/profile/route.ts`:
```ts
import { NextRequest } from "next/server";
import { listServiceWeeks, createServiceWeek } from "./handler";

export async function GET(req: NextRequest): Promise<Response> { return listServiceWeeks(req); }
export async function POST(req: NextRequest): Promise<Response> { return createServiceWeek(req); }
```

### 5. `app/api/service-weeks/[id]/handler.ts` — CREATE (get one + update)

```ts
export async function getServiceWeek(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>;
export async function updateServiceWeek(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>;
```
Import `toServiceWeekResponse` (and `ServiceWeekResponse` if needed) from `../handler`.

**`getServiceWeek` (GET /api/service-weeks/:id) — Auth: any authenticated member.**
1. `requireAuth`; JWT/supabase (401 if no JWT).
2. Query `service_weeks` by `.eq("id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`.
   On `error` → 500. On `!data` → 404 `NOT_FOUND`.
3. **Guest scoping:** if `ctx.role === "guest"`, verify an `invitations` row exists for
   `service_week_id = id` AND `user_id = ctx.userId`. If none → 404 `NOT_FOUND` (do NOT leak
   existence via 403). On invitation-query error → 500.
4. Return `ok({ serviceWeek: toServiceWeekResponse(row) })` (200).

**`updateServiceWeek` (PUT /api/service-weeks/:id) — Auth: set_leader / admin only.**
1. `requireAuth`; `requireRole(ctx, ["admin", "set_leader"])`.
2. Parse body with `updateServiceWeekSchema` → 400 `VALIDATION_FAILED` on failure.
3. JWT/supabase (401 if no JWT).
4. Build a snake_case partial update object from only the provided fields
   (`serviceDate→service_date`, `title`, `sermonTopic→sermon_topic`,
   `sermonScripture→sermon_scripture`, `speakerName→speaker_name`).
5. `supabase.from("service_weeks").update(patch).eq("id", id).eq("church_group_id", ctx.churchGroupId)
   .select(...).maybeSingle()`. On `error` → 500. On `!data` (no row matched) → 404 `NOT_FOUND`.
6. Return `ok({ serviceWeek: toServiceWeekResponse(row) })` (200).

### 6. `app/api/service-weeks/[id]/route.ts` — REWRITE GET + PUT, keep DELETE stub

Next.js 15: the second arg is `{ params }: { params: Promise<{ id: string }> }`; `await params`.
```ts
import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";
import { getServiceWeek, updateServiceWeek } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getServiceWeek(req, id);
}
export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return updateServiceWeek(req, id);
}
export async function DELETE(_req: NextRequest) {
  return notImplemented("DELETE /api/service-weeks/[id]"); // #38 — out of scope
}
```

### 7. Tests — CREATE

Copy the mock/harness style of `tests/unit/app/api/profile-route.test.ts`
(`jest.mock("@clerk/nextjs/server")`, `jest.mock("@/lib/supabase/client")`, `makeLookup`,
`setUpAuth`, a `makeSupabaseClient` fixture keyed by table name). The Supabase mock must support
the chains used: `.select().eq()...` (+ `.order`), `.eq().eq().maybeSingle()`,
`.insert().select().maybeSingle()`, `.update().eq().eq().select().maybeSingle()`, and `.in(...)`.
Give `makeLookup` a `role` argument so guest/member/leader/admin can be exercised.

- `tests/unit/app/api/service-weeks-route.test.ts` — covers `listServiceWeeks` + `createServiceWeek`.
- `tests/unit/app/api/service-weeks-id-route.test.ts` — covers `getServiceWeek` + `updateServiceWeek`.

Required cases per the Edge cases below.

---

## Edge cases the implementation MUST handle

1. **No Clerk session** → 401 `UNAUTHENTICATED` (lookup never consulted). All four handlers.
2. **No Supabase JWT** (`getToken` returns null) → 401 `UNAUTHENTICATED`; `getSupabaseClient` not called.
3. **POST/PUT by a `member` or `guest`** → 403 `FORBIDDEN` (from `requireRole`).
4. **POST with missing/empty any of the five fields, or bad `serviceDate` format** → 400 `VALIDATION_FAILED`.
5. **POST malformed/non-JSON body** (`req.json()` throws → null) → 400 `VALIDATION_FAILED`.
6. **POST success** → 201; response is camelCase `serviceWeek`; a draft `setlists` row is inserted
   with the new `service_week_id` and no explicit `status`. Assert the setlist insert was attempted
   (capture the insert payload; assert no `status` key).
7. **Setlist auto-insert error after week insert succeeds** → 500 `INTERNAL`.
8. **GET list as a guest** → only weeks with a matching `invitations` row for that user; guest with
   zero invitations → `{ serviceWeeks: [] }`.
9. **GET list as member/leader/admin** → all weeks in the group.
10. **GET :id not found / different tenant** → 404 `NOT_FOUND`.
11. **GET :id as guest with no invitation for that week** → 404 `NOT_FOUND` (not 403).
12. **PUT with empty body `{}`** → 400 `VALIDATION_FAILED` (refine: at least one field).
13. **PUT :id not found** (no row matched the `id`+tenant) → 404 `NOT_FOUND`.
14. **PUT partial update** → only provided fields are written; assert the captured update payload
    contains only the mapped snake_case keys sent.
15. **Any DB `error`** on a query/insert/update → 500 `INTERNAL`.

## Out of scope (do NOT implement)

- `DELETE /api/service-weeks/:id`, `/cancel`, `/reactivate` (#38/#39) — leave as `notImplemented`.
- Setlist song editing / publish, event CRUD, invitation sending (#54/#59/#40).
- Chat room creation (no table — OPEN QUESTION 1).
- Audit-log writes (not in this issue's AC).
- Regenerating full Supabase types — only add the three tables needed.
