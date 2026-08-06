# Spec — Issue #77: [Sprint 4] Audit input validation (Zod) across all Phase 1 routes

## OPEN QUESTIONS

None. Proceed.

(Reviewer note, not a blocker: PRD §15.3 is not checked into this repo, so the
three previously-unbounded free-text limits below were chosen to match the
nearest existing precedent already in `schemas/` rather than a PRD number.
They are documented explicitly in "Change 2".)

---

## Context — what the audit already found

I read every file under `app/api/**` and every file under `schemas/`. The
codebase is already in good shape: 21 of 21 JSON-body endpoints already
`safeParse` through a Zod schema in `schemas/`, all query-param endpoints
except one already do, and all DB access already goes through the Supabase
SDK (`.from()/.eq()/.rpc()`), which parameterizes.

This issue is therefore **four small, surgical changes plus a written audit
record** — not a rewrite. Do exactly what is listed below and nothing else.

---

## Change 1 — PostgREST filter-string injection in the song search (AC 3)

**This is the only place in `app/**` or `lib/**` where a database filter is
built by string interpolation from user input**, and it is a real breakout:

`app/api/songs/handler.ts:72`
```ts
query = query.or(`title.ilike.%${q}%,artist.ilike.%${q}%`);
```
`q` comes straight from `?q=` (`songSearchQuerySchema`, which only trims and
caps length). A `q` containing `,`, `(`, `)` or `.` breaks out of the
`or=(...)` grammar and lets the caller append arbitrary PostgREST filters to
the query.

### 1a. Create `lib/api/postgrest.ts`

```ts
/**
 * Escapes a user-supplied value for use inside a PostgREST filter string
 * (e.g. the argument to `.or()`), where reserved characters like `,` `.`
 * `(` `)` would otherwise break out of the filter grammar.
 *
 * PostgREST allows a filter value to be double-quoted; inside those quotes
 * only `"` and `\` are special. Callers must wrap the returned value in
 * double quotes themselves, e.g. `title.ilike."%${escaped}%"`.
 */
export function escapePostgrestFilterValue(value: string): string;
```

Implementation: escape backslashes first, then double quotes. No other
transformation — do **not** strip or escape `%`/`*`; wildcard semantics of the
existing search are unchanged.

Notes:
- Do **not** add `import "server-only"` — this must stay unit-testable as a
  pure function (compare `lib/invitations/state-machine.ts`, which has no
  `server-only` import; `lib/api/response.ts` does, and is not the model here).
- Pure, no I/O, no dependencies.

### 1b. Use it in `app/api/songs/handler.ts`

Replace the interpolation in `listSongs` with a double-quoted, escaped form:

```ts
const escaped = escapePostgrestFilterValue(q);
query = query.or(`title.ilike."%${escaped}%",artist.ilike."%${escaped}%"`);
```

Keep everything else in that function identical (the `if (q)` guard, ordering,
error mapping).

### 1c. Update the one existing assertion this changes

`tests/unit/app/api/songs-route.test.ts:186` currently asserts:
```ts
expect(selectChain.or).toHaveBeenCalledWith("title.ilike.%amaz%,artist.ilike.%amaz%");
```
Update it to the new quoted form for `q: "amaz"`. Change only this line; do
not restructure the test file. (Additional adversarial cases are the Testing
stage's job, not yours.)

---

## Change 2 — Unbounded string fields (AC 2)

Three request fields currently have **no `.max()`** at all, so a multi-megabyte
body reaches Postgres. Every other string field in `schemas/` is already
bounded (verified field by field: church-group 100/50/100/2048, songs
200/200/5/50, instruments 100, song-documents 200/50/1024, profile bio 2000,
availability note 500, invitations roleNote 500 + denial reason 200,
setlists notes 1000 / keyOverride 5, events name 100 / location 200).

Add these caps, and nothing else:

**`schemas/service-weeks.ts`**
- `createServiceWeekSchema.sermonTopic`: `z.string().trim().min(1).max(200)`
- `createServiceWeekSchema.sermonScripture`: `z.string().trim().min(1).max(200)`
- `updateServiceWeekSchema.sermonTopic`: same, `.optional()`
- `updateServiceWeekSchema.sermonScripture`: same, `.optional()`

**`schemas/events.ts`**
- `createEventSchema.notes`: `z.string().trim().min(1).max(2000).nullish()`
- `updateEventSchema.notes`: same

Rationale to put in a short code comment above each changed field: these are
`text` columns in Postgres (`service_weeks.sermon_topic`,
`service_weeks.sermon_scripture`, `events.notes` — see
`supabase/migrations/20260702000003_cluster_3_scheduling_core.sql`), so the
cap is an app-layer limit. 200 matches the repo's existing "short titled
text" convention (`songs.title`, `song_documents.name`); 2000 matches the
existing long-free-text convention (`schemas/profile.ts` `bio`).

Do **not** change any limit that already exists. In particular leave
`denyInvitationSchema.reason` at `.max(200)` — it already satisfies the AC's
named "denial reason ≤200 chars".

---

## Change 3 — Missing query-param schema on the Google Calendar OAuth callback (AC 1)

`app/api/google-calendar/callback/handler.ts` is the **only** route that reads
query params without a Zod schema: it pulls `error`, `code`, `state` straight
off `req.nextUrl.searchParams` (lines 36-39) and hands `code` to
`exchangeCode()`.

### 3a. `schemas/google-calendar.ts`

Replace the placeholder `googleCalendarSchema` stub (and its TODO comment)
with a real schema:

```ts
// GET /api/google-calendar/callback query params. Google sends either
// `error` (user denied consent) or `code` + `state`. All three are opaque
// provider-supplied strings — bound their length so a hostile redirect
// can't push an unbounded value into exchangeCode()/the CSRF comparison.
export const googleCalendarCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().min(1).max(200).optional(),
});
export type GoogleCalendarCallbackQuery = z.infer<typeof googleCalendarCallbackQuerySchema>;
```

Do not add `.trim()` — these are provider-issued opaque tokens.

Check with a repo-wide search that nothing imports the removed
`googleCalendarSchema` / `GoogleCalendarInput` before deleting them; if
anything does, keep them and just add the new export.

### 3b. `app/api/google-calendar/callback/handler.ts`

Follow the existing query-param pattern from
`app/api/church-group/audit-log/handler.ts:28-33`:

```ts
const parsedQuery = googleCalendarCallbackQuerySchema.safeParse(
  Object.fromEntries(req.nextUrl.searchParams),
);
if (!parsedQuery.success) {
  return redirectError();
}
const { error, code, state } = parsedQuery.data;
```

**Critical edge case:** this route must *never* return JSON. Every failure
path — including the new validation failure — returns `redirectError()`
(302 to `/profile?calendar=error`, state cookie cleared), not
`fail(...)`. Keep the rest of the function (the `if (error)` short-circuit,
the `if (!code || !state)` guard, the CSRF cookie comparison, the upsert,
the best-effort `syncAllEventsForUser`) behaviourally identical.

Existing tests in `tests/unit/app/api/google-calendar-callback-route.test.ts`
pass `code: "abc"` / a base64url `state` / `error: "access_denied"`; all three
must still pass unchanged. Do not modify that test file.

---

## Change 4 — Invitation `:id` path param validated in deny/withdraw (AC 1)

`acceptInvitation` already validates its `:id` route param
(`acceptInvitationParamSchema`, `app/api/invitations/handler.ts:520`), but its
two siblings in the same file do not: `denyInvitation` passes the raw `id`
into the `deny_invitation` RPC's `uuid` argument (line ~301), and
`withdrawInvitation` passes it into `.eq("id", id)`. A malformed id currently
surfaces as a 500 "Internal error" instead of a 400.

### 4a. `schemas/invitations.ts`

Add:
```ts
// Route param for /api/invitations/:id/* (deny, withdraw). Same shape as
// acceptInvitationParamSchema.
export const invitationIdParamSchema = z.string().uuid();
```
Leave `acceptInvitationParamSchema` and the unused `invitationsSchema` stub
exactly as they are.

### 4b. `app/api/invitations/handler.ts`

- In `denyInvitation`: validate `id` with `invitationIdParamSchema` as the
  **first** statement inside the `try`, before `req.json()`, returning
  `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)` on failure.
  This must run before either branch (token / in-app) so both are covered.
- In `withdrawInvitation`: validate `id` immediately after the existing
  `requireAuth` + `requireRole` calls (keep 401/403 taking precedence over
  400, matching `patchMemberRole` in
  `app/api/church-group/members/[id]/role/handler.ts:24-34`), same 400 on
  failure.
- Continue passing the original `id` variable to the RPC/queries — no
  renaming, no behaviour change for well-formed UUIDs.

Every existing test for these two handlers already passes a real UUID
(`INVITATION_ID = "33333333-..."`), so no test file changes are needed here.

---

## Change 5 — Write the audit record (AC 1, 3, 4)

The issue is an audit; the audit result is a deliverable. Put it in
`.pipeline/changes.md` (the normal Coding-stage artifact) — **do not create a
new standalone `.md` report file anywhere in the repo.** Include, in addition
to your usual summary of changes:

1. **Route inventory table** — one row per `app/api/**/route.ts` (58 files)
   with: path, HTTP methods, and the validation status of each input surface
   (body / query / route param), naming the schema used. Mark the routes that
   are still `notImplemented()` 501 stubs (`app/api/notifications/**` ×5,
   `app/api/webhooks/**` ×4, `GET /api/church-group`) as "no input surface —
   501 stub", and note that `schemas/notifications.ts` is a deliberately empty
   placeholder with no route consuming it.
2. **AC 3 result** — the exact search commands you ran and their output,
   confirming that after Change 1 there is no remaining SQL or PostgREST
   filter string built by interpolation from user input in `app/**` or
   `lib/**`. Search at minimum for: `` .or(` ``, `.filter(`, `.rpc(`,
   `` sql` ``, `exec_sql`, and `${` inside template literals passed to
   Supabase methods. Record the one remaining hit —
   `tests/integration/rls/setup.ts:149` (`svc.rpc("exec_sql", { query: sql })`)
   — and state explicitly that `sql` there is the static file
   `supabase/seed-rls-test.sql` read from disk in test setup, with no user
   input, so it is not a finding.
3. **AC 4 result** — confirmation that every DB call in `app/**` and `lib/**`
   goes through the Supabase JS SDK (`.from(...)`, `.rpc(...)`), with the
   RPC list enumerated (`create_church_group`, `join_church_group`,
   `remove_church_group_member`, `write_audit_log`, `accept_invitation`,
   `deny_invitation`, `get_invitation_by_token`, `send_invitation_reminders`,
   `record_availability_conflict`, `get_event_sync_targets`,
   `get_user_sync_targets`, `flag_calendar_token_invalid`) and the note that
   all arguments are passed as named RPC parameters, never interpolated.

---

## Explicitly OUT of scope — do not do these

- **Blanket UUID validation of every `:id` route param.** ~20 handlers pass a
  route param straight into `.eq("id", id)`. These are *not* an injection risk
  (the SDK parameterizes) — the only symptom is a 500 instead of a 404 for a
  malformed id. Fixing it repo-wide would require rewriting ~25 existing tests
  that deliberately pass non-UUID ids (`"missing-id"`, `"instr-1"` — see
  `tests/unit/app/api/instruments-route.test.ts`,
  `tests/unit/app/api/auth-matrix.test.ts`,
  `tests/unit/app/api/service-weeks-*.test.ts`). That is its own issue. Change
  4 is limited to deny/withdraw *because* it makes them consistent with their
  own sibling `acceptInvitation` at zero test cost. Mention this finding in
  the `.pipeline/changes.md` audit record as a known, deliberate gap.
- Rate limiting (issue #76).
- Writing new tests (that is the Testing stage). The only test edit you make
  is the single assertion line in Change 1c.
- Filling in `schemas/notifications.ts`, or implementing any `notImplemented`
  route.
- Refactoring the two existing inline `const targetIdSchema = z.string().uuid()`
  declarations in `app/api/church-group/members/[id]/handler.ts` and
  `app/api/church-group/members/[id]/role/handler.ts` into a shared helper.
- Any change to `lib/supabase/types.ts`, RLS policies, or migrations.

---

## Patterns to copy

| For | Copy from |
| --- | --- |
| Body validation + 400 shape | `app/api/songs/handler.ts:95-100` (`createSong`) |
| Query-param validation + 400 shape | `app/api/church-group/audit-log/handler.ts:28-34` |
| Route-param validation + 400 shape | `app/api/invitations/handler.ts:520-523` (`acceptInvitation`) |
| Auth-then-validate ordering (401/403 before 400) | `app/api/church-group/members/[id]/role/handler.ts:24-36` |
| Schema file style (comment naming the route + BR/PRD ref, `z.infer` type export) | `schemas/invitations.ts` |
| Pure, unit-testable `lib/` helper with no `server-only` | `lib/invitations/state-machine.ts` |

## Files touched (exact list)

Create:
- `lib/api/postgrest.ts`

Modify:
- `app/api/songs/handler.ts`
- `schemas/service-weeks.ts`
- `schemas/events.ts`
- `schemas/google-calendar.ts`
- `app/api/google-calendar/callback/handler.ts`
- `schemas/invitations.ts`
- `app/api/invitations/handler.ts`
- `tests/unit/app/api/songs-route.test.ts` (one assertion line only)
- `.pipeline/changes.md`

Nothing else.

## Verification before you finish

```
bun run lint
bun run typecheck
bun run test
```
All three must pass. The full existing suite must stay green — if any test
other than `tests/unit/app/api/songs-route.test.ts:186` starts failing, you
have changed behaviour beyond this spec; revert that part rather than editing
the test.
