# Spec — Issue #63: iCal (.ics) export fallback

## OPEN QUESTIONS

None. This is buildable as specified. See **Decisions** for two choices I made
that are defensible without human sign-off (both are implementation choices,
not product decisions requiring a human).

## Goal (scope)

Let a member download their **assigned** events as a valid `.ics` file so they
can import into any calendar app, independent of Google Calendar connection
status. Export-only. Two-way sync is out of scope.

"Assigned events" = rows in `event_attendees` where `user_id` is the caller
(the attendee model from #60), NOT the invitation-scoped list used by
`GET /api/events`. This matches the AC wording ("a member's assigned events").

Two entry points, both scoped to the caller's own attendee rows:
- **Single event**: `GET /api/events/[id]/ics`
- **Full schedule / week**: `GET /api/events/ics` (optional `?serviceWeekId=<uuid>`
  filter narrows it to one service week — this is the "full week" case).

No role gate: any authenticated member (`guest`/`member`/`set_leader`/`admin`)
may export their own assigned events. RLS already tenant-scopes `events` and
`event_attendees`, so the caller's own JWT-scoped Supabase client is sufficient
(no SECURITY DEFINER RPC needed here).

## Decisions

- **DECISION 1 — hand-rolled generator, no new dependency.** The issue says a
  library is "sufficient", not required. The repo already hand-rolls its
  Google Calendar integration via `fetch` (`lib/google-calendar/sync.ts`) and
  avoids unnecessary deps. A minimal, single-`VEVENT`-per-event RFC 5545
  generator is small, fully unit-testable with no network, and avoids adding a
  package + `bun.lock` churn during the coding stage. Build it in `lib/ical/`.
  Do NOT run `bun add`.
- **DECISION 2 — empty export is a 404, not an empty calendar.** RFC 5545
  requires a `VCALENDAR` to contain at least one component, and some importers
  reject a component-less calendar. So when the caller has zero matching
  assigned events, return `404 NOT_FOUND` ("No events to export") rather than a
  200 with an empty file.

## UI scope

**No UI in this issue.** The member week screen
(`app/(app)/member-week/[id]/page.tsx`) is still a `"coming soon"` placeholder,
so there is nowhere to correctly place a member-facing download button yet. The
endpoints below set `Content-Disposition: attachment`, so hitting the URL
directly downloads the file — that is the deliverable download mechanism.
Wiring a button belongs with the member-week screen build (separate issue). Do
not build a new screen here.

## Files to create

### 1. `lib/ical/generate.ts` — pure ICS generator (no `server-only`; keep unit-testable)

Follow the pure-function + heavy-comment style of `schemas/events.ts`.

```ts
export type IcalEventInput = {
  uid: string;          // globally-unique, stable per event
  title: string;        // maps to SUMMARY
  start: string;        // ISO 8601 with offset (events.start_time)
  end: string;          // ISO 8601 with offset (events.end_time)
  location?: string | null;   // omit LOCATION line when null/empty
  description?: string | null; // omit DESCRIPTION line when null/empty
};

// Serializes one or more events into a single RFC 5545 VCALENDAR string.
// `now` is injectable so DTSTAMP is deterministic in tests.
export function generateIcs(
  events: IcalEventInput[],
  opts?: { now?: Date },
): string;

// Exported for unit testing:
export function formatIcsDate(date: Date): string;   // -> "YYYYMMDDTHHMMSSZ" (UTC)
export function escapeIcsText(value: string): string; // RFC 5545 3.3.11
export function foldLine(line: string): string;       // 75-octet folding
```

Required output rules (all mandatory for a valid, importable file):

- **CRLF (`\r\n`) line endings everywhere**, including a trailing CRLF after the
  final `END:VCALENDAR`.
- Calendar wrapper, in order:
  - `BEGIN:VCALENDAR`
  - `VERSION:2.0`
  - `PRODID:-//Graceful//Graceful//EN`
  - `CALSCALE:GREGORIAN`
  - `METHOD:PUBLISH`
  - ...one `VEVENT` block per event...
  - `END:VCALENDAR`
- Each `VEVENT`, in order:
  - `BEGIN:VEVENT`
  - `UID:<uid>`
  - `DTSTAMP:<formatIcsDate(now)>`  (now defaults to `new Date()`)
  - `DTSTART:<formatIcsDate(new Date(start))>`
  - `DTEND:<formatIcsDate(new Date(end))>`
  - `SUMMARY:<escapeIcsText(title)>`
  - `LOCATION:<escapeIcsText(location)>`  (omit line entirely if null/empty/whitespace)
  - `DESCRIPTION:<escapeIcsText(description)>`  (omit line entirely if null/empty/whitespace)
  - `END:VEVENT`
- `formatIcsDate`: convert to UTC basic format. Implementation:
  `date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")`
  e.g. `2026-07-12T09:00:00.000Z` -> `20260712T090000Z`.
- `escapeIcsText`: escape in this order — backslash `\` -> `\\`, then `;` -> `\;`,
  `,` -> `\,`, and CRLF/CR/LF -> `\n`.
- `foldLine`: any content line longer than 75 octets must be folded — split into
  <=75-octet chunks joined by `\r\n ` (CRLF + single space). Apply folding to
  each assembled content line (property name + value) before joining. Simplest
  correct approach: build each property line as a string, run `foldLine` on it,
  then join all lines with CRLF.

### 2. `app/api/events/[id]/ics/handler.ts` — single-event export

Mirror the auth/JWT boilerplate of `app/api/events/[id]/handler.ts`.

```ts
export async function exportEventIcs(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>;
```

Logic:
1. `ctx = await requireAuth(req, lookup)` (no `requireRole`).
2. Resolve Supabase JWT exactly like existing handlers; missing JWT ->
   `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
3. Verify the caller is an attendee of this event:
   ```ts
   supabase.from("event_attendees").select("id")
     .eq("event_id", id).eq("user_id", ctx.userId).maybeSingle()
   ```
   On error -> 500. On no row -> `fail("Not found", ErrorCode.NOT_FOUND, 404)`
   (do not leak events the caller is not assigned to).
4. Fetch the event row:
   ```ts
   supabase.from("events")
     .select("id, name, location, notes, start_time, end_time")
     .eq("id", id).maybeSingle()
   ```
   On error -> 500. On no row -> 404.
5. Build one `IcalEventInput` (see mapping below), call `generateIcs([...])`,
   return via `icsResponse(ics, filename)` (see helper below). Filename:
   `icsFilename(event.name)`.

### 3. `app/api/events/[id]/ics/route.ts`

Mirror `app/api/events/[id]/route.ts`:

```ts
import { NextRequest } from "next/server";
import { exportEventIcs } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return exportEventIcs(req, id);
}
```

### 4. `app/api/events/ics/handler.ts` — full schedule / week export

```ts
export async function exportEventsIcs(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response>;
```

Logic:
1. `ctx = await requireAuth(req, lookup)` (no role gate).
2. Read optional filter: `const serviceWeekId = req.nextUrl.searchParams.get("serviceWeekId")`.
   If present, validate it is a uuid (reuse `z.string().uuid()` from zod, or a
   simple regex). Invalid -> `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
3. Resolve Supabase JWT (same 401 path as above).
4. Get the caller's assigned event ids:
   ```ts
   supabase.from("event_attendees").select("event_id").eq("user_id", ctx.userId)
   ```
   -> `eventIds = [...new Set(rows.map(r => r.event_id))]`.
   If `eventIds.length === 0` -> `fail("No events to export", ErrorCode.NOT_FOUND, 404)`.
5. Fetch those events, newest-first-agnostic ordering by start time ascending:
   ```ts
   let q = supabase.from("events")
     .select("id, name, location, notes, start_time, end_time")
     .in("id", eventIds)
     .order("start_time", { ascending: true });
   if (serviceWeekId) q = q.eq("service_week_id", serviceWeekId);
   ```
   On error -> 500. If the result is empty (e.g. `serviceWeekId` matched none of
   their events) -> `fail("No events to export", ErrorCode.NOT_FOUND, 404)`.
6. Map every row to `IcalEventInput`, `generateIcs(...)`, return via
   `icsResponse(ics, filename)`. Filename: `graceful-events.ics` (or
   `graceful-week-<serviceWeekId truncation not needed>` — keep it simple, use
   `graceful-events.ics` in both cases).

### 5. `app/api/events/ics/route.ts`

```ts
import { NextRequest } from "next/server";
import { exportEventsIcs } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return exportEventsIcs(req);
}
```

Note: `ics` is a static segment sibling of `[id]` under `app/api/events/`; Next
resolves the static `ics` path before `[id]`, and no real event UUID equals
"ics", so there is no route collision.

## Shared helpers (put in the two handlers or a tiny local module)

Add these small helpers. Simplest: define once in `lib/ical/generate.ts` and
import into both handlers (keeps handlers thin). Your call, but do not duplicate
divergent copies.

```ts
// Builds the text/calendar attachment Response.
export function icsResponse(ics: string, filename: string): Response {
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// Safe download filename from an event name: lowercase, non-alnum -> "-",
// collapse repeats, trim leading/trailing "-", fall back to "event", add ".ics".
export function icsFilename(name: string): string;
```

`NextResponse` is imported from `next/server`. `icsResponse` uses `NextResponse`,
so if you place it in `lib/ical/generate.ts` keep that file free of `server-only`
but importing `next/server` is fine. (Alternative: keep `icsResponse`/`icsFilename`
inline in each handler and keep `generate.ts` framework-free. Either is acceptable
— pick one and be consistent.)

## Row -> IcalEventInput mapping (identical in both handlers)

```ts
{
  uid: `${row.id}@graceful.app`, // stable + globally unique per event
  title: row.name,
  start: row.start_time,
  end: row.end_time,
  location: row.location,   // may be null
  description: row.notes,   // may be null
}
```

## Edge cases the implementation MUST handle

1. **Unauthenticated / missing JWT** -> 401 (`requireAuth` throws
   `ApiException`; missing supabase JWT -> explicit 401 `fail`), matching every
   existing events handler.
2. **Single event the caller is not assigned to (or nonexistent)** -> 404
   (do not distinguish "exists but not yours" from "doesn't exist").
3. **Zero assigned events (full export)** -> 404 "No events to export".
4. **`serviceWeekId` filter matches none of the caller's assigned events** -> 404.
5. **Invalid `serviceWeekId` query param** -> 400 VALIDATION_FAILED.
6. **null `location` / `notes`** -> omit the `LOCATION` / `DESCRIPTION` line
   entirely (do not emit an empty-value line).
7. **Text with `,` `;` `\` or newlines** in name/location/notes -> escaped per
   `escapeIcsText`.
8. **Long `notes`** (schema allows unbounded length) -> line-folded at 75 octets.
9. **Timezone correctness** -> stored times are `timestamptz` ISO strings;
   `DTSTART`/`DTEND` must be emitted in UTC `...Z` basic format (no local-time
   drift). `formatIcsDate` handles this via `toISOString()`.
10. **CRLF endings + trailing CRLF** — required; LF-only files fail strict parsers.
11. **Supabase query error** at any step -> `fail("Internal error", ErrorCode.INTERNAL, 500)`.
12. Wrap each handler body in `try/catch`, ending with the standard
    `if (err instanceof ApiException) return fail(...)` / else 500, exactly like
    the existing events handlers.

## Tests to add (tester stage will also add its own)

Mirror the mocking style of `tests/unit/app/api/events-route.test.ts`
(`jest.mock` for `@clerk/nextjs/server` and `@/lib/supabase/client`; fake
`UserLookup`).

- `tests/unit/lib/ical/generate.test.ts`:
  - happy path: known event -> asserts VCALENDAR/VEVENT structure, correct
    `DTSTART`/`DTEND` UTC values, CRLF endings, `DTSTAMP` via injected `now`.
  - escaping: `,`/`;`/`\`/newline in title & description.
  - null location/notes -> lines omitted.
  - long description -> folded lines (each physical line <= 75 octets, folded
    continuation starts with a single space).
- `tests/unit/app/api/events-ics-route.test.ts`:
  - single event happy path -> 200, `Content-Type: text/calendar; charset=utf-8`,
    `Content-Disposition` attachment header, body contains one `VEVENT`.
  - single event, caller not an attendee -> 404.
  - full export happy path (multiple events) -> 200, body contains N `VEVENT`s.
  - full export, zero assigned events -> 404.
  - unauthenticated (null JWT) -> 401.
  - invalid `serviceWeekId` -> 400.

## Patterns to copy (named files)

- Handler auth/JWT/try-catch/`ok`/`fail` shape: `app/api/events/[id]/handler.ts`
  and `app/api/events/handler.ts`.
- Attendee lookup by `event_id`+`user_id`: `app/api/events/[id]/attendees/handler.ts`.
- Route `params` unwrapping: `app/api/events/[id]/route.ts`.
- Pure, heavily-commented, unit-testable helper module: `schemas/events.ts`.
- Test mocking harness: `tests/unit/app/api/events-route.test.ts`.

## Verify before finishing (coding stage)

`bun run lint`, `bun run typecheck`, `bun run test`. Do not use npm/npx.
