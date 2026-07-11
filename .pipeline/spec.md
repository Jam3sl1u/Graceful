# Spec — Issue #34: Implement availability set/get

## OPEN QUESTION (needs human decision, but a concrete default is specced below)

1. **How are "weekly / monthly blocks" expressed in the `PUT` body?** The
   `availability` table is one row per `(user_id, date)` — there is no recurring
   or range column. Two readings of the AC ("sets availability for one or more
   dates (weekly or per-day), and supports monthly blocks"):
   - (a) Client always sends explicit per-date entries; server just upserts them.
   - (b) Server accepts optional inclusive date **ranges** and expands them into
     per-date upserts, so a member can block a whole month in one call.

   **Default chosen for this spec: (b).** It satisfies "monthly blocks for known
   absences" without forcing the client to enumerate 30 dates, and still supports
   single dates. If the team prefers (a), drop the `startDate`/`endDate` branch
   from `setAvailabilityEntrySchema` and the expansion loop — nothing else changes.

Everything below is unambiguous and must be implemented.

## Current state (already in repo — do not recreate)

- DB table `availability` exists (migration `20260702000005_cluster_5_partial.sql`):
  `id uuid pk`, `user_id uuid not null → users(id)`, `church_group_id uuid not null → church_groups(id)`,
  `date date not null`, `is_available boolean not null default true`, `note text`,
  `created_at timestamptz not null default now()`, `unique (user_id, date)`.
- RLS is live (`20260704000001_rls_policies.sql`): SELECT is group-scoped
  (`church_group_id = auth_church_group_id()`); INSERT/UPDATE/DELETE allow a row
  only when `user_id = auth_user_id()` OR the caller is leader/admin. A
  leader/admin passing `user_id` on GET will therefore only ever see rows in
  their own group.
- Route stubs exist and currently return `notImplemented`:
  `app/api/availability/route.ts` (GET, PUT).
- `app/api/availability/[date]/route.ts` (DELETE) and
  `app/api/availability/team/route.ts` (GET) are **out of scope** (#35, #36) —
  leave them as stubs, do not touch.
- `schemas/availability.ts` is an empty placeholder — replace it.
- `lib/supabase/types.ts` has NO `availability` table type — you must add one.

## Files to modify / create

### 1. `lib/supabase/types.ts` (modify)

Add an `AvailabilityRow` type and register it under
`Database.public.Tables.availability`, following the exact pattern of the other
rows in this file (e.g. `member_profiles`, `service_weeks`).

```ts
type AvailabilityRow = {
  id: string;
  user_id: string;
  church_group_id: string;
  date: string; // YYYY-MM-DD
  is_available: boolean;
  note: string | null;
  created_at: string;
};
```

Registration (same `Insert` treatment for DB-defaulted columns as the existing
rows):

```ts
availability: {
  Row: AvailabilityRow;
  Insert: Omit<AvailabilityRow, "id" | "created_at" | "is_available"> & {
    id?: string;
    created_at?: string;
    is_available?: boolean;
  };
  Update: Partial<AvailabilityRow>;
  Relationships: [];
};
```

### 2. `schemas/availability.ts` (replace the placeholder)

Define and export:

```ts
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD

// GET /api/availability query params
export const getAvailabilityQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
});
export type GetAvailabilityQuery = z.infer<typeof getAvailabilityQuerySchema>;

// One PUT entry: EITHER a single `date` OR an inclusive `startDate`..`endDate`
// range. isAvailable defaults true (applied in handler). note: trimmed; empty →
// null.
export const setAvailabilityEntrySchema = z.object({ ... });

// PUT /api/availability body
export const setAvailabilitySchema = z.object({
  entries: z.array(setAvailabilityEntrySchema).min(1).max(400),
});
export type SetAvailabilityInput = z.infer<typeof setAvailabilitySchema>;
```

Entry validation rules (enforce with `.refine` / `.superRefine`):
- Fields: `date?`, `startDate?`, `endDate?` (all optional strings),
  `isAvailable: z.boolean().optional()`,
  `note: z.string().trim().max(500).nullish().transform(v => (v && v.length > 0 ? v : null))`
  (copy the bio normalization in `schemas/profile.ts`).
- Exactly one form must be present: EITHER `date` alone, OR both `startDate` and
  `endDate` together. Presence of `date` together with either range field, or
  neither form, → validation error.
- Every date string present must match `DATE_RE` AND be a real calendar date
  (reject `2026-02-30`; validate by round-tripping, e.g. construct the date and
  confirm it re-serializes to the same string, or check `!Number.isNaN(Date.parse(s))`
  plus the regex).
- For a range, `startDate <= endDate` (lexicographic compare is correct for
  `YYYY-MM-DD`).

Follow the zod style already used in `schemas/profile.ts` and
`schemas/audit-log.ts`.

### 3. `app/api/availability/handler.ts` (create)

Copy the structure, auth flow, JWT/`getSupabaseClient` handling, and try/catch
error mapping from `app/api/profile/handler.ts`. Query-param parsing follows
`app/api/church-group/audit-log/handler.ts`
(`Object.fromEntries(req.nextUrl.searchParams)`).

Export a response type and two handlers:

```ts
export type AvailabilityEntry = {
  userId: string;
  date: string;       // YYYY-MM-DD
  isAvailable: boolean;
  note: string | null;
};

export async function getAvailability(req: NextRequest, lookup?: UserLookup): Promise<Response>;
export async function setAvailability(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

**`getAvailability`:**
1. `ctx = await requireAuth(req, lookup)`.
2. Parse query with
   `getAvailabilityQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))`;
   on failure → 400 `VALIDATION_FAILED`.
3. Determine `targetUserId`:
   - If `user_id` is present AND differs from `ctx.userId`:
     `requireRole(ctx, ["admin", "set_leader"])` (throws 403 `FORBIDDEN` for a
     plain member reading someone else's).
   - Else `targetUserId = ctx.userId`.
4. Get JWT (`auth()` → `getToken({ template: "supabase" })`); missing → 401
   `UNAUTHENTICATED` (same as profile handler).
5. `supabase.from("availability").select("user_id, date, is_available, note")
   .eq("user_id", targetUserId).order("date", { ascending: true })`.
   RLS already restricts to the caller's group; no explicit `church_group_id`
   filter needed.
6. On error → 500 `INTERNAL`.
7. Map rows → `AvailabilityEntry[]`, return `ok({ availability })`.
   Absence of a row for a date means "available"; this endpoint returns only
   stored rows and does NOT synthesize future dates — the "defaults to true if
   unset" semantic belongs to the consumer (e.g. the #36 grid).

**`setAvailability`:**
1. `ctx = await requireAuth(req, lookup)`. Scope is the caller's OWN availability
   only (the AC does not ask for leaders setting others via PUT). No extra role gate.
2. `body = await req.json().catch(() => null)`; `setAvailabilitySchema.safeParse(body)`;
   failure → 400 `VALIDATION_FAILED`.
3. Expand every entry into concrete dates:
   - single-date entry → `[date]`.
   - range entry → each date from `startDate` to `endDate` inclusive.
   - Enforce a total expanded-date cap of **366**; if exceeded → 400
     `VALIDATION_FAILED` (guards against a member blocking years by accident).
4. **Dedupe by date, last-entry-wins.** A single Postgres upsert cannot touch the
   same conflict target `(user_id, date)` twice in one statement, so collapse
   duplicates into a `Map<string /* date */, { isAvailable; note }>` before
   building rows. This is a required edge case.
5. Get JWT; missing → 401 `UNAUTHENTICATED`.
6. Build one row per resolved date:
   `{ user_id: ctx.userId, church_group_id: ctx.churchGroupId, date, is_available: isAvailable ?? true, note }`.
   Use the same narrow cast the profile handler uses for the DB-defaulted-column
   mismatch:
   `... as unknown as Database["public"]["Tables"]["availability"]["Insert"][]`.
7. `supabase.from("availability").upsert(rows, { onConflict: "user_id,date" })
   .select("user_id, date, is_available, note")`.
8. On error → 500 `INTERNAL`.
9. Map returned rows → `AvailabilityEntry[]`, return `ok({ availability })`.
10. Wrap everything in the same try/catch that maps
    `ApiException` → `fail(err.message, err.code, err.status)` and anything else → 500 `INTERNAL`.

### 4. `app/api/availability/route.ts` (modify)

Replace the `notImplemented` stubs with thin delegators, exactly like
`app/api/profile/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAvailability, setAvailability } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getAvailability(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return setAvailability(req);
}
```

## Edge cases the implementation MUST handle

- Clerk `userId` null → 401 `UNAUTHENTICATED`, lookup never consulted (handled by `requireAuth`).
- Missing supabase JWT → 401 `UNAUTHENTICATED`, `getSupabaseClient` never called.
- GET with `user_id` = another member, caller is a plain `member` → 403 `FORBIDDEN`.
- GET with `user_id` equal to the caller's own id → allowed for any role.
- GET with malformed `user_id` (not a uuid) → 400 `VALIDATION_FAILED`.
- PUT empty `entries: []` → 400 `VALIDATION_FAILED`.
- PUT entry with both `date` and a range field, or neither → 400.
- PUT range with `startDate > endDate` → 400.
- PUT invalid calendar date (e.g. `2026-02-30`) → 400.
- PUT expanded total > 366 dates → 400.
- PUT duplicate dates across entries → deduped, last wins, single successful upsert.
- PUT `isAvailable` omitted → row stored/returned with `isAvailable: true`.
- PUT `note` empty/whitespace → stored as `null`.
- PUT re-setting an existing `(user_id, date)` → updates in place (upsert), no duplicate-key error.
- Any DB error on select/upsert → 500 `INTERNAL`.

## Response envelope

Use `ok(...)` / `fail(...)` from `lib/api/response.ts`. Success bodies:
- GET: `{ data: { availability: AvailabilityEntry[] } }`
- PUT: `{ data: { availability: AvailabilityEntry[] } }`

## Patterns to copy (named)

- Handler skeleton, auth+JWT flow, try/catch error mapping, DB-default `Insert`
  cast: `app/api/profile/handler.ts`.
- Route delegator: `app/api/profile/route.ts`.
- Role gating with `requireRole`: `app/api/church-group/members/handler.ts`.
- Query-param parsing: `app/api/church-group/audit-log/handler.ts`.
- Zod schema style + note/bio normalization: `schemas/profile.ts`.
- `lib/supabase/types.ts` table registration: existing `member_profiles` entry.

## Tests (tester stage — for reference, not written by planner)

Add `tests/unit/app/api/availability-route.test.ts` mirroring
`tests/unit/app/api/profile-route.test.ts` (mock `@clerk/nextjs/server` and
`@/lib/supabase/client`; mock the `.select().eq().order()` and
`.upsert().select()` chains). Cover every edge case above. An RLS integration
test already exists at `tests/integration/rls/tables/availability.test.ts` — do
not duplicate RLS coverage in the unit test.

## Explicitly out of scope (do NOT implement)

- Conflict detection on availability change (#46).
- DELETE `/api/availability/[date]` unset (#35) — leave stub untouched.
- Team availability grid / `GET /api/availability/team` (#36) — leave stub untouched.
- Leaders/admins setting *another* member's availability via PUT (not in the AC).
