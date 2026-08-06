# Changes — Issue #77: [Sprint 4] Audit input validation (Zod) across all Phase 1 routes

Four small, surgical fixes plus the audit record the issue requires as a
deliverable. No rewrite, no scope creep — see "Explicitly OUT of scope" at
the bottom for what was deliberately left alone.

## Code changes

1. **`lib/api/postgrest.ts` (new)** — `escapePostgrestFilterValue(value)`,
   a pure function that escapes `\` then `"` so a value can be safely
   embedded inside a double-quoted PostgREST filter term. No I/O, no
   `server-only` import (unit-testable), mirrors `lib/invitations/state-machine.ts`.

2. **`app/api/songs/handler.ts` (`listSongs`)** — fixed a real PostgREST
   filter-string injection: `q` (the free-text search term, only
   trimmed/length-capped by `songSearchQuerySchema`) was interpolated
   directly into `.or(\`title.ilike.%${q}%,artist.ilike.%${q}%\`)`. A `q`
   containing `,`, `(`, `)`, or `.` could break out of the `or=(...)` filter
   grammar and append arbitrary PostgREST filters. Now:
   ```ts
   const escaped = escapePostgrestFilterValue(q);
   query = query.or(`title.ilike."%${escaped}%",artist.ilike."%${escaped}%"`);
   ```
   Wildcard semantics (`%`/`*`) are unchanged — only `\` and `"` are escaped.

3. **`tests/unit/app/api/songs-route.test.ts`** — updated the one assertion
   this changes (line 186) from
   `"title.ilike.%amaz%,artist.ilike.%amaz%"` to the new quoted form
   `'title.ilike."%amaz%",artist.ilike."%amaz%"'`. No other lines touched.

4. **`schemas/service-weeks.ts`** — added `.max(200)` to
   `createServiceWeekSchema.sermonTopic`, `createServiceWeekSchema.sermonScripture`,
   `updateServiceWeekSchema.sermonTopic` (optional), and
   `updateServiceWeekSchema.sermonScripture` (optional). These were the only
   unbounded string fields in the file. Comment above each explains these are
   `text` columns with no DB-level cap, so this is an app-layer limit,
   matching the repo's existing "short titled text" convention (200, same
   as `songs.title`/`song_documents.name`).

5. **`schemas/events.ts`** — added `.max(2000)` to `createEventSchema.notes`
   and `updateEventSchema.notes` (both stay `.nullish()`). Comment explains
   `events.notes` is a `text` column with no DB-level cap, and 2000 matches
   the repo's existing long-free-text convention (`schemas/profile.ts` bio).

6. **`schemas/google-calendar.ts`** — replaced the placeholder
   `googleCalendarSchema`/`GoogleCalendarInput` stub (verified nothing
   imported either — safe to remove entirely, not just add alongside) with
   a real schema for the OAuth callback's query params:
   ```ts
   export const googleCalendarCallbackQuerySchema = z.object({
     code: z.string().min(1).max(2048).optional(),
     state: z.string().min(1).max(512).optional(),
     error: z.string().min(1).max(200).optional(),
   });
   export type GoogleCalendarCallbackQuery = z.infer<typeof googleCalendarCallbackQuerySchema>;
   ```
   No `.trim()` — these are provider-issued opaque tokens.

7. **`app/api/google-calendar/callback/handler.ts` (`callback`)** — this was
   the one route reading query params without going through Zod at all
   (`error`, `code`, `state` pulled straight off `searchParams.get(...)`).
   Now parses via `googleCalendarCallbackQuerySchema.safeParse(Object.fromEntries(...))`
   (same pattern as `app/api/church-group/audit-log/handler.ts`); on parse
   failure it calls `redirectError()` — never `fail(...)` — preserving the
   route's "always redirect, never JSON" contract on every failure path.
   Rest of the function (the `if (error)` short-circuit, the
   `if (!code || !state)` guard, the CSRF cookie comparison, the upsert,
   the best-effort `syncAllEventsForUser`) is behaviourally identical.
   `tests/unit/app/api/google-calendar-callback-route.test.ts` was **not**
   modified and still passes unchanged (its `code`/`state`/`error` values
   all satisfy the new schema).

8. **`schemas/invitations.ts`** — added
   `export const invitationIdParamSchema = z.string().uuid();` (same shape
   as `acceptInvitationParamSchema`, left untouched, as was the unused
   `invitationsSchema` stub).

9. **`app/api/invitations/handler.ts`**:
   - `denyInvitation`: validates `id` with `invitationIdParamSchema` as the
     first statement inside the `try` block, before `req.json()`, returning
     `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)` on
     failure. Runs before the token/in-app branch split, so both paths are
     covered.
   - `withdrawInvitation`: validates `id` immediately after the existing
     `requireAuth` + `requireRole` calls (401/403 still take precedence
     over 400, matching `patchMemberRole` in
     `app/api/church-group/members/[id]/role/handler.ts`).
   - Both still pass the original `id` variable through to the RPC/queries
     unchanged — no behaviour change for well-formed UUIDs. No test file
     changes needed (every existing test for these two handlers already
     passes a real UUID).

## Verification

```
bun run lint       # clean, no warnings
bun run typecheck  # clean
bun run test       # 82 suites / 1051 tests, all passing
```
The only intentional test-assertion change is
`tests/unit/app/api/songs-route.test.ts:186`; nothing else in the suite
changed behavior.

---

## Audit record (issue deliverable — AC 1, 3, 4)

### 1. Route inventory (`app/api/**/route.ts`, 57 files)

*(The spec estimated 58; the repo actually contains 57 `route.ts` files —
counted via `find app/api -name "route.ts" | wc -l`. All are covered below.)*

Legend: "—" = no input surface on that method for that surface type.
"raw, no schema (OUT OF SCOPE)" = existing, pre-issue gap, deliberately not
touched — see "Known deliberate gap" below.

| Path | Methods | Body validation | Query validation | Route param validation |
| --- | --- | --- | --- | --- |
| `app/api/_examples/admin-only/route.ts` | GET | — | — | — |
| `app/api/availability/[date]/route.ts` | DELETE | — | — | `availabilityDateParamSchema` |
| `app/api/availability/route.ts` | GET, PUT | PUT: `setAvailabilitySchema` | GET: `getAvailabilityQuerySchema` | — |
| `app/api/availability/team/route.ts` | GET | — | `getTeamAvailabilityQuerySchema` | — |
| `app/api/church-group/audit-log/route.ts` | GET | — | `auditLogQuerySchema` | — |
| `app/api/church-group/join/route.ts` | POST | `joinChurchGroupSchema` | — | — |
| `app/api/church-group/members/[id]/role/route.ts` | PATCH | `updateRoleSchema` | — | inline `targetIdSchema = z.string().uuid()` |
| `app/api/church-group/members/[id]/route.ts` | DELETE | — | — | inline `targetIdSchema = z.string().uuid()` |
| `app/api/church-group/members/route.ts` | GET | — | — | — |
| `app/api/church-group/route.ts` | GET, PUT | PUT: `createChurchGroupSchema` | — | — (GET is a **501 stub**) |
| `app/api/conflicts/[id]/resolve/route.ts` | POST | `resolveConflictSchema` | — | raw, no schema (OUT OF SCOPE) |
| `app/api/conflicts/route.ts` | GET | — | — | — |
| `app/api/cron/invitation-reminders/route.ts` | GET | — | — | — (auth is `CRON_SECRET` bearer token, not a body/query/param input) |
| `app/api/events/[id]/attendees/[userId]/route.ts` | DELETE | — | — | raw `id`/`userId`, no schema (OUT OF SCOPE) |
| `app/api/events/[id]/attendees/route.ts` | POST | `assignAttendeeSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/events/[id]/ics/route.ts` | GET | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/events/[id]/route.ts` | PUT, DELETE | PUT: `updateEventSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/events/ics/route.ts` | GET | — | inline `serviceWeekIdSchema = z.string().uuid()` | — |
| `app/api/events/route.ts` | GET, POST | POST: `createEventSchema` | — | — |
| `app/api/google-calendar/callback/route.ts` | GET | — | **`googleCalendarCallbackQuerySchema`** (Change 3, this issue) | — |
| `app/api/google-calendar/connect/route.ts` | POST | — | — | — |
| `app/api/google-calendar/disconnect/route.ts` | DELETE | — | — | — |
| `app/api/health/route.ts` | GET | — | — | — |
| `app/api/instruments/[id]/promote/route.ts` | POST | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/instruments/[id]/route.ts` | DELETE | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/instruments/custom/route.ts` | POST | `createInstrumentSchema` | — | — |
| `app/api/instruments/route.ts` | GET, POST | POST: `createInstrumentSchema` | — | — |
| `app/api/invitations/[id]/accept/route.ts` | POST | `acceptInvitationSchema` | — | `acceptInvitationParamSchema` |
| `app/api/invitations/[id]/deny/route.ts` | POST | `denyInvitationSchema` | — | **`invitationIdParamSchema`** (Change 4, this issue) |
| `app/api/invitations/[id]/route.ts` | DELETE (withdraw) | — | — | **`invitationIdParamSchema`** (Change 4, this issue) |
| `app/api/invitations/respond/[token]/route.ts` | GET | — | — | `respondTokenParamSchema` |
| `app/api/invitations/route.ts` | GET, POST | POST: `createInvitationSchema` | GET: `listInvitationsQuerySchema` | — |
| `app/api/notifications/[id]/read/route.ts` | PATCH | no input surface — **501 stub** | | |
| `app/api/notifications/mark-all-read/route.ts` | POST | no input surface — **501 stub** | | |
| `app/api/notifications/preferences/route.ts` | GET, PUT | no input surface — **501 stub** | | |
| `app/api/notifications/route.ts` | GET | no input surface — **501 stub** | | |
| `app/api/notifications/unread-count/route.ts` | GET | no input surface — **501 stub** | | |
| `app/api/profile/route.ts` | GET, PUT | PUT: `updateProfileSchema` | — | — |
| `app/api/service-weeks/[id]/cancel/route.ts` | POST | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/service-weeks/[id]/member-view/route.ts` | GET | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/service-weeks/[id]/reactivate/route.ts` | POST | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/service-weeks/[id]/route.ts` | GET, PUT, DELETE | PUT: `updateServiceWeekSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/service-weeks/[id]/setlist/route.ts` | GET, POST | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/service-weeks/route.ts` | GET, POST | POST: `createServiceWeekSchema` | — | — |
| `app/api/setlists/[id]/publish/route.ts` | POST | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/setlists/[id]/route.ts` | GET, PUT (reorder) | PUT: `reorderSetlistSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/setlists/[id]/songs/[songId]/route.ts` | DELETE | — | — | raw `id`/`songId`, no schema (OUT OF SCOPE) |
| `app/api/setlists/[id]/songs/route.ts` | POST | `addSetlistSongSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/setlists/[id]/unlock/route.ts` | POST | — | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/songs/[id]/documents/[docId]/route.ts` | DELETE | — | — | raw `id`/`docId`, no schema (OUT OF SCOPE) |
| `app/api/songs/[id]/documents/route.ts` | GET, POST | POST: `registerDocumentSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/songs/[id]/documents/upload-url/route.ts` | POST | `uploadUrlSchema` | — | raw `id`, no schema (OUT OF SCOPE) |
| `app/api/songs/route.ts` | GET, POST | POST: `createSongSchema` | GET: `songSearchQuerySchema` | — |
| `app/api/webhooks/clerk/route.ts` | POST | no input surface — **501 stub** | | |
| `app/api/webhooks/modal/route.ts` | POST | no input surface — **501 stub** | | |
| `app/api/webhooks/pingram/route.ts` | POST | no input surface — **501 stub** | | |
| `app/api/webhooks/resend/route.ts` | POST | no input surface — **501 stub** | | |

`schemas/notifications.ts` is a deliberately empty placeholder
(`export const notificationsSchema = z.object({})`) — no route currently
imports or consumes it; the five `app/api/notifications/**` routes above are
all still `notImplemented()` 501 stubs.

### 2. AC 3 result — PostgREST/SQL filter-string injection sweep

Commands run (from repo root, after Change 1 landed) and their output:

```
$ grep -rn '\.or(`' app lib
app/api/songs/handler.ts:74:      query = query.or(`title.ilike."%${escaped}%",artist.ilike."%${escaped}%"`);

$ grep -rn '\.filter(`' app lib
(no output)

$ grep -rn '\.rpc(`' app lib
(no output)

$ grep -rn 'sql`' app lib
(no output)

$ grep -rn 'exec_sql' app lib tests
tests/integration/rls/setup.ts:149:  const { error } = await svc.rpc("exec_sql", { query: sql }).single();
tests/integration/rls/setup.ts:152:    // Fallback: execute via raw query if exec_sql RPC not available.
tests/integration/rls/setup.ts:163: * the context around the RPC call

$ grep -rn '\.\(or\|filter\|rpc\|eq\|match\)(`[^`]*\${' app lib
app/api/songs/handler.ts:74:      query = query.or(`title.ilike."%${escaped}%",artist.ilike."%${escaped}%"`);
```

Result: after Change 1, the only remaining template-literal-interpolated
filter/query construction anywhere in `app/**` or `lib/**` is the fixed,
now-escaped `.or(...)` call in `app/api/songs/handler.ts`. The one
`exec_sql` hit is `tests/integration/rls/setup.ts:149`
(`svc.rpc("exec_sql", { query: sql })`) — `sql` there is the static file
`supabase/seed-rls-test.sql` read from disk in test setup (not `app/**`/
`lib/**`, and not user input), so it is **not a finding**.

### 3. AC 4 result — all DB access goes through the Supabase SDK

Every DB call in `app/**` and `lib/**` goes through `.from(...)`/`.rpc(...)`
on the Supabase JS SDK client (`getSupabaseClient`/`getAnonSupabaseClient`
in `lib/supabase/client.ts`), which parameterizes all values — confirmed by
the same sweep above finding zero raw/templated SQL construction outside
the one non-finding above.

RPCs called (all arguments passed as named RPC parameters — `{ p_foo: ... }`
object literals — never string-interpolated):
- `create_church_group` (`app/api/church-group/route.ts`)
- `join_church_group` (`app/api/church-group/join/route.ts`)
- `remove_church_group_member` (`app/api/church-group/members/[id]/handler.ts`)
- `write_audit_log` (`lib/audit/write-audit-log.ts`)
- `accept_invitation` (`app/api/invitations/handler.ts`)
- `deny_invitation` (`app/api/invitations/handler.ts`, no-session path)
- `get_invitation_by_token` (`app/api/invitations/handler.ts`)
- `send_invitation_reminders` (`app/api/cron/invitation-reminders/route.ts`)
- `record_availability_conflict` (`lib/scheduling/conflict-detection.ts`)
- `get_event_sync_targets` (`lib/google-calendar/sync.ts`)
- `get_user_sync_targets` (`lib/google-calendar/sync.ts`)
- `flag_calendar_token_invalid` (`lib/google-calendar/sync.ts`)

### Known deliberate gap (not fixed here — mentioned per spec)

~20 handlers pass a route `:id` param straight into `.eq("id", id)` without
a `z.string().uuid()` check first (see "raw, no schema (OUT OF SCOPE)" rows
in the inventory table above). This is **not** an injection risk — the
Supabase SDK parameterizes the value regardless of shape — the only symptom
is a malformed id surfacing as a 500 "Internal error" instead of a 404.
Fixing it repo-wide would require rewriting ~25 existing tests that
deliberately pass non-UUID ids (e.g. `"missing-id"`, `"instr-1"` in
`tests/unit/app/api/instruments-route.test.ts`,
`tests/unit/app/api/auth-matrix.test.ts`,
`tests/unit/app/api/service-weeks-*.test.ts`). Per spec, that's out of
scope for this issue — a separate issue if a human wants uniform
route-param validation. Change 4 (this issue) only closed the gap for
`denyInvitation`/`withdrawInvitation` because it made them consistent with
their own sibling `acceptInvitation` at zero test cost.

## What the Testing stage should focus on

- The escaped PostgREST filter in `listSongs`: confirm a `q` containing
  `,`, `(`, `)`, `.`, `"`, or `\` no longer breaks the filter grammar or lets
  extra `.or()` clauses through (adversarial cases beyond the one existing
  assertion are explicitly the Testing stage's job per spec).
- The three new `.max()` caps (`service-weeks` sermonTopic/sermonScripture,
  `events` notes) reject over-limit input with 400 and still accept
  in-range input.
- `google-calendar/callback`: confirm a malformed/oversized `code`/`state`/
  `error` now redirects to `/profile?calendar=error` (302, state cookie
  cleared) rather than reaching `exchangeCode()` — and that the three
  existing passing cases (`code: "abc"`, base64url `state`,
  `error: "access_denied"`) still pass unchanged.
- `denyInvitation`/`withdrawInvitation` with a malformed `:id` now returning
  400 VALIDATION_FAILED instead of a 500, on both the token and in-app
  branches of `denyInvitation`, and confirm withdraw's 401/403-before-400
  ordering.
