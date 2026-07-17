# Changes — Issue #63: iCal (.ics) export fallback

Implements the export-only `.ics` download endpoints exactly as specced in
`.pipeline/spec.md`. No UI, no new dependency, no scope creep beyond the two
GET endpoints and the pure generator they share.

## Files created

- **`lib/ical/generate.ts`** — pure, framework-light RFC 5545 generator (no
  `server-only`, so it's unit-testable without a request context). Exports:
  - `generateIcs(events, opts?)` — builds a full `VCALENDAR` string with one
    `VEVENT` per input event, CRLF line endings throughout plus a trailing
    CRLF, `DTSTAMP` driven by an injectable `opts.now` (defaults to
    `new Date()`).
  - `formatIcsDate(date)` — `Date` -> UTC basic format
    (`toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")`).
  - `escapeIcsText(value)` — RFC 5545 §3.3.11 escaping, in the required order
    (backslash, then `;`, then `,`, then CRLF/CR/LF -> literal `\n`).
  - `foldLine(line)` — 75-octet content-line folding. First chunk gets 75
    octets, continuation chunks get 74 (since the leading `" "` on each
    continuation line counts toward that line's 75-octet budget). Splits on
    byte boundaries without cutting a multi-byte UTF-8 character.
  - `icsResponse(ics, filename)` — builds the `text/calendar` attachment
    `Response` (imports `NextResponse` from `next/server`; this is the one
    piece of this file that isn't purely framework-free, per the spec's
    explicit allowance).
  - `icsFilename(name)` — safe download filename: lowercase, non-alphanumeric
    runs collapsed to a single `-`, leading/trailing `-` trimmed, falls back
    to `"event"` for an empty/all-symbol name, appends `.ics`.
  - `LOCATION`/`DESCRIPTION` lines are omitted entirely when the source value
    is `null`/empty/whitespace-only (never emitted as an empty-value line).

- **`app/api/events/[id]/ics/handler.ts`** — `exportEventIcs(req, id, lookup?)`.
  Mirrors the auth/JWT/try-catch shape of `app/api/events/[id]/handler.ts`:
  `requireAuth` (no role gate) -> resolve Supabase JWT (401 if missing) ->
  confirm the caller is an attendee via `event_attendees` (`event_id` +
  `user_id`, `maybeSingle`) -> 404 if not assigned (never distinguishes
  "not yours" from "doesn't exist") -> fetch the `events` row -> 404 if
  missing -> map to `IcalEventInput` -> `generateIcs([...])` ->
  `icsResponse(ics, icsFilename(event.name))`.

- **`app/api/events/[id]/ics/route.ts`** — `GET` wrapper unwrapping the async
  `params`, mirrors `app/api/events/[id]/route.ts`.

- **`app/api/events/ics/handler.ts`** — `exportEventsIcs(req, lookup?)`.
  `requireAuth` -> parse optional `?serviceWeekId=<uuid>` (`z.string().uuid()`,
  400 `VALIDATION_FAILED` if present but invalid) -> resolve Supabase JWT
  (401 if missing) -> collect the caller's assigned event ids from
  `event_attendees` (deduped via `Set`) -> 404 `"No events to export"` if
  zero -> fetch matching `events` rows (`.in("id", eventIds)`, optionally
  `.eq("service_week_id", serviceWeekId)`, `.order("start_time", { ascending:
  true })`) -> 404 if the (possibly filtered) result is empty -> map every row
  to `IcalEventInput` -> `generateIcs(...)` -> `icsResponse(ics,
  "graceful-events.ics")`. The optional filter is applied before
  `.order(...)` (mirrors `app/api/songs/handler.ts`'s conditional-builder
  pattern) to keep the Supabase query-builder typing happy.

- **`app/api/events/ics/route.ts`** — thin `GET` wrapper, mirrors
  `app/api/events/[id]/route.ts`'s style (no params to unwrap here since
  there's no dynamic segment).

- **`tests/unit/lib/ical/generate.test.ts`** — unit tests for
  `formatIcsDate`, `escapeIcsText`, `foldLine`, `generateIcs`, and
  `icsFilename`: UTC conversion (including a non-UTC-offset input), escaping
  order/edge cases, CRLF-only line endings + trailing CRLF, VEVENT field
  correctness, `DTSTAMP` via injected `now` and via the real-clock default,
  omission of null/empty `LOCATION`/`DESCRIPTION`, long-description folding
  (every physical line <= 75 octets, continuation lines start with a single
  space, and the folded text round-trips back to the original), multi-event
  output, and filename sanitization.

- **`tests/unit/app/api/events-ics-route.test.ts`** — route-handler tests for
  both endpoints, mirroring the `jest.mock`/chainable-Supabase-mock style of
  `tests/unit/app/api/events-route.test.ts`: 401 (no Clerk userId / no JWT),
  404 (not an attendee / event doesn't exist / zero assigned events /
  `serviceWeekId` matches nothing), 400 (invalid `serviceWeekId`), 500 on any
  Supabase error, and 200 happy paths asserting `Content-Type: text/calendar;
  charset=utf-8`, the `Content-Disposition: attachment` filename, and VEVENT
  count/content (including the `serviceWeekId`-scoped case and confirming
  null location/notes don't produce empty `LOCATION:`/`DESCRIPTION:` lines).

## What the Tester should focus on

- The empty-export decision: zero matching assigned events is a 404
  (`"No events to export"`), not a 200 with an empty calendar — both for the
  full-export endpoint (zero attendee rows) and the `serviceWeekId`-filtered
  case (attendee rows exist but none match the week).
- The attendee-scoping distinction: both endpoints check `event_attendees`
  (the #60 attendee model), not the invitation-scoped list used by
  `GET /api/events` — confirm a caller who has an *invitation* but is not an
  assigned *attendee* still gets a 404 from `GET /api/events/:id/ics`.
- `escapeIcsText`/`foldLine` correctness on the actual `generateIcs` output
  (not just the pure functions in isolation) — e.g. a `notes`/`location`
  value containing `,`, `;`, `\`, or embedded newlines, run through the full
  handler.
- Line folding on a genuinely long `notes` value end-to-end through the
  handler (schema allows unbounded length; the generator must fold it).
- No new dependency was added — `bun.lock` is untouched; confirm
  `bun run lint && bun run typecheck && bun run test` all still pass clean
  (they did in this stage: 75 suites / 960 tests passed, 0 lint errors, 0
  typecheck errors).
- No UI was added or wired — this is intentionally out of scope per the
  spec (member-week screen is still a placeholder).
