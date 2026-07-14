# Spec — Issue #59: Event CRUD + BR-10 time validation (Sprint 3)

No OPEN QUESTIONS. Two decisions were forced by the DB schema / PRD and are
documented under "Decisions" below rather than blocked — they are defensible and
deterministic; a human/reviewer can override if wrong.

## Scope

Implement the four event endpoints that are currently `notImplemented` stubs:

- `POST /api/events` — create an event (admin/set_leader), enforce BR-10.
- `GET  /api/events` — list events, role-scoped.
- `PUT  /api/events/:id` — update an event (admin/set_leader), re-enforce BR-10.
- `DELETE /api/events/:id` — hard-delete an event (admin/set_leader).

Out of scope (do NOT touch): Google Calendar sync (#62 — leave
`google_calendar_event_id` null, do not read/write it), attendee assignment
(#60 — do not touch `event_attendees`, do not add a `GET /api/events/:id`).

## Pattern to copy

Copy the structure, auth flow, JWT/Supabase acquisition, narrow Insert cast,
try/catch → `fail(...)` shape, and camelCase request/response convention from
the **service-weeks** handlers (events is a child of service_weeks and the
closest analog):

- `app/api/service-weeks/handler.ts` → list + create + `toServiceWeekResponse`.
- `app/api/service-weeks/[id]/handler.ts` → update + delete.
- `app/api/service-weeks/[id]/route.ts` → `[id]` route wiring (`Ctx` param).

BR-10 (a business-rule value check that returns **422**, not a Zod shape check
that returns 400) copies the BR-09 split from `app/api/songs/handler.ts`
lines 102-106 and `schemas/songs.ts` (`isValidSongKey`): keep the pure check
helper in `schemas/events.ts`, call it in the handler, return
`fail(..., ErrorCode.VALIDATION_FAILED, 422)` on violation.

Use camelCase body/response keys (like service-weeks: `serviceDate`,
`sermonTopic`), NOT snake_case.

## Files

### 1. `schemas/events.ts` — REPLACE the stub entirely

Current content is a placeholder empty object. Replace with:

```ts
import { z } from "zod";

export const eventTypeSchema = z.enum([
  "pre_practice",
  "rehearsal",
  "sound_check",
  "service",
]);

// POST /api/events body. Shape only. BR-10 time-window/order is enforced in
// the handler (returns 422, not 400) via validateEventTiming below.
export const createEventSchema = z.object({
  serviceWeekId: z.string().uuid(),
  type: eventTypeSchema,
  name: z.string().trim().min(1).max(100),
  location: z.string().trim().min(1).max(200).nullish(),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  notes: z.string().trim().min(1).nullish(),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

// PUT /api/events/:id body — same mutable fields, all optional, at least one
// present. serviceWeekId is intentionally NOT updatable (moving an event
// between weeks is out of scope).
export const updateEventSchema = z
  .object({
    type: eventTypeSchema.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    location: z.string().trim().min(1).max(200).nullish(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().min(1).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field required");
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

// BR-10 (PRD §8): end must be after start; both within 72h of service_date.
// Pure + deterministic so it is unit-testable in isolation. service_date is a
// DATE (YYYY-MM-DD); anchor it at 00:00:00 UTC (see Decisions in spec).
// Returns an error message string on violation, or null when valid.
export const BR10_WINDOW_MS = 72 * 60 * 60 * 1000;

export function validateEventTiming(
  serviceDate: string,
  startTime: string,
  endTime: string,
): string | null {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (!(end > start)) return "end_time must be after start_time";
  const anchor = new Date(`${serviceDate}T00:00:00.000Z`).getTime();
  if (Math.abs(start - anchor) > BR10_WINDOW_MS || Math.abs(end - anchor) > BR10_WINDOW_MS) {
    return "event times must be within 72 hours of the service date";
  }
  return null;
}
```

Note: `z.string().datetime({ offset: true })` guarantees the strings parse, so
`new Date(...)` cannot be `NaN` in `validateEventTiming`.

### 2. `app/api/events/handler.ts` — NEW file (mirror `service-weeks/handler.ts`)

Export:

- `type EventResponse = { id: string; serviceWeekId: string; type: EventType; name: string; location: string | null; startTime: string; endTime: string; notes: string | null; createdBy: string | null; createdAt: string; }`
  (Do NOT expose `google_calendar_event_id` — out of scope. Import `EventType`
  from `@/types/domain`.)
- `function toEventResponse(row: EventsRow): EventResponse` — snake→camel map.
  Use `type EventsRow = Database["public"]["Tables"]["events"]["Row"]`.
- `async function listEvents(req: NextRequest, lookup?: UserLookup): Promise<Response>`
- `async function createEvent(req: NextRequest, lookup?: UserLookup): Promise<Response>`

**`listEvents` (role-scoped, see AC):**
1. `ctx = await requireAuth(req, lookup)` (any authenticated role — no
   `requireRole`).
2. Acquire supabase JWT client exactly as service-weeks does (getToken
   `template: "supabase"`, 401 if missing).
3. If `ctx.role === "admin"`: select all events where
   `church_group_id === ctx.churchGroupId`, `.order("start_time", { ascending: true })`.
4. Else (`set_leader` / `member` / `guest` — ALL non-admins are scoped, unlike
   service-weeks where only guests are): query `invitations` for
   `service_week_id` where `user_id === ctx.userId`; dedupe into
   `serviceWeekIds`; if empty return `ok({ events: [] })`; else select events
   where `church_group_id === ctx.churchGroupId` AND
   `.in("service_week_id", serviceWeekIds)`, same ordering.
5. Return `ok({ events: (data ?? []).map(toEventResponse) })`.
6. On any supabase `error`: `fail("Internal error", ErrorCode.INTERNAL, 500)`.

**`createEvent` (admin/set_leader):**
1. `ctx = await requireAuth(req, lookup)`; `requireRole(ctx, ["admin", "set_leader"])`.
2. `body = await req.json().catch(() => null)`;
   `createEventSchema.safeParse` → on failure `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
3. Acquire supabase JWT client (401 if no jwt).
4. Verify the parent week: select `service_date` from `service_weeks` where
   `id === parsed.serviceWeekId` AND `church_group_id === ctx.churchGroupId`,
   `.maybeSingle()`. On error → 500. If not found →
   `fail("Not found", ErrorCode.NOT_FOUND, 404)` (do not leak existence /
   cross-group).
5. **BR-10:** `const msg = validateEventTiming(week.service_date, parsed.startTime, parsed.endTime)`;
   if `msg` non-null → `fail(msg, ErrorCode.VALIDATION_FAILED, 422)`.
6. Insert (narrow cast exactly like service-weeks' `weekInsertPayload`
   `as unknown as Database["public"]["Tables"]["events"]["Insert"]`):
   ```
   church_group_id: ctx.churchGroupId,
   service_week_id: parsed.serviceWeekId,
   type: parsed.type,
   name: parsed.name,
   location: parsed.location ?? null,
   start_time: parsed.startTime,
   end_time: parsed.endTime,
   notes: parsed.notes ?? null,
   created_by: ctx.userId,
   ```
   `.select("*").maybeSingle()`. On error/null → 500.
7. `return ok({ event: toEventResponse(row) }, 201)`.
8. Wrap in the standard try/catch: `if (err instanceof ApiException) return fail(err.message, err.code, err.status); return fail("Internal error", ErrorCode.INTERNAL, 500);`.

### 3. `app/api/events/route.ts` — REPLACE the stub

```ts
import { NextRequest } from "next/server";
import { listEvents, createEvent } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listEvents(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return createEvent(req);
}
```

### 4. `app/api/events/[id]/handler.ts` — NEW file (mirror `service-weeks/[id]/handler.ts`)

Import `toEventResponse` from `../handler` and
`updateEventSchema, validateEventTiming` from `@/schemas/events`. Export:

- `async function updateEvent(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>`
- `async function deleteEvent(req: NextRequest, id: string, lookup?: UserLookup): Promise<Response>`

**`updateEvent` (admin/set_leader):**
1. `requireAuth` + `requireRole(ctx, ["admin", "set_leader"])`.
2. Parse body with `updateEventSchema.safeParse` → 400 on failure.
3. Acquire supabase JWT client (401 if none).
4. Fetch existing event: select `*` from `events` where `id === id` AND
   `church_group_id === ctx.churchGroupId`, `.maybeSingle()`. Error → 500,
   not found → 404.
5. **BR-10 re-check when times change:** if `parsed.startTime !== undefined ||
   parsed.endTime !== undefined`, fetch `service_date` from `service_weeks`
   (id = `existing.service_week_id`, church_group_id = ctx.churchGroupId;
   error → 500), compute
   `effectiveStart = parsed.startTime ?? existing.start_time`,
   `effectiveEnd = parsed.endTime ?? existing.end_time`, run
   `validateEventTiming(...)`; non-null → 422 VALIDATION_FAILED. (If neither
   time field is present, skip BR-10.)
6. Build `patch: Database["public"]["Tables"]["events"]["Update"] = {}`,
   assigning only the keys present in `parsed` (mirror
   `updateServiceWeek`'s `if (parsed.x !== undefined) patch.x = ...` — note
   `location`/`notes` are `.nullish()`, so guard with `!== undefined` and pass
   the value through as-is, allowing an explicit `null` to clear the column).
   Map camelCase → snake_case: `type→type`, `name→name`, `location→location`,
   `startTime→start_time`, `endTime→end_time`, `notes→notes`.
7. `.update(patch).eq("id", id).eq("church_group_id", ctx.churchGroupId).select("*").maybeSingle()`.
   Error → 500, null → 404.
8. `return ok({ event: toEventResponse(row) })`.

**`deleteEvent` (admin/set_leader):**
1. `requireAuth` + `requireRole(ctx, ["admin", "set_leader"])`.
2. Acquire supabase JWT client (401 if none).
3. `.delete().eq("id", id).eq("church_group_id", ctx.churchGroupId).select("id").maybeSingle()`
   — select the deleted row so a missing/cross-group id returns 404 rather
   than a silent 200. Error → 500; null → `fail("Not found", ErrorCode.NOT_FOUND, 404)`.
   (`event_attendees` children are removed by DB-level cascade — do not delete
   them here.)
4. `return ok({ deleted: true })`.

Both wrapped in the standard `ApiException` try/catch.

### 5. `app/api/events/[id]/route.ts` — REPLACE the stub

Mirror `service-weeks/[id]/route.ts` but with only PUT + DELETE (no GET — not
in AC and #60 owns event-level reads):

```ts
import { NextRequest } from "next/server";
import { updateEvent, deleteEvent } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return updateEvent(req, id);
}
export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return deleteEvent(req, id);
}
```

## Edge cases the implementation MUST handle

- **BR-10 order:** `end_time <= start_time` (equal or reversed) → 422
  VALIDATION_FAILED. Equal times are a violation (must be *after*).
- **BR-10 window:** `start_time` OR `end_time` more than 72h (absolute) from
  the service_date anchor → 422. A valid event is one where BOTH endpoints are
  within the window AND end > start.
- **Malformed body** (bad/missing type enum, missing name, non-ISO datetime,
  bad uuid) → 400 VALIDATION_FAILED (Zod), NOT 422. Only a syntactically valid
  body that violates the time *rule* is 422. This 400-vs-422 split is the crux
  of the issue.
- **Unknown / cross-group `serviceWeekId` on create** → 404 NOT_FOUND (never
  leak existence of another group's week).
- **Unknown / cross-group event id on PUT/DELETE** → 404 NOT_FOUND.
- **Unauthenticated** (no Clerk user, or no supabase JWT) → 401 UNAUTHENTICATED.
- **Wrong role** on POST/PUT/DELETE (member/guest) → 403 FORBIDDEN.
- **GET scoping:** admin sees every event in the group; a non-admin with zero
  invitations sees `{ events: [] }` (never another member's events, never
  another group's events).
- **`location`/`notes`:** omitted → stored `null` on create; on update an
  explicit `null` clears the column, omission leaves it unchanged.

## Decisions (forced, documented, not blocking)

1. **`name` is required on create.** The `events` DB row (`EventsRow.name:
   string`, non-null; dependency #18) and the `events` Insert type both require
   `name`, even though the issue's AC parenthetical omits it. It is therefore a
   required `createEventSchema` field. Not invented — mandated by the schema.
2. **72h anchor = `service_date` at 00:00:00 UTC.** `service_date` is a DATE
   with no time/zone. BR-10 / PRD §8 give no timezone. Anchoring at UTC
   midnight and using an absolute ±72h window is deterministic and testable.
   The church group's timezone is intentionally NOT used here (keeps this
   issue self-contained; revisit if a human wants group-tz-relative windows).

## Verification (Coder must run before finishing)

- `bun run lint`
- `bun run typecheck`
- `bun run test`

Do not use npm/yarn/pnpm. The tester stage will add the event route tests
(copy the harness from `tests/unit/app/api/songs-route.test.ts` /
`service-weeks-*` tests, which inject the `lookup` seam and mock
`@clerk/nextjs/server` + `getSupabaseClient`).
