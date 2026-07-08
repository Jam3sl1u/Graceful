# Spec — Issue #33: RLS bypass tests for Sprint 0–1 tables

## OPEN QUESTIONS

1. **CI "block merge on failure" depends on repo config, not code.** The
   `rls-integration` job in `.github/workflows/ci.yml` only runs
   `if: needs.check-secrets.outputs.has-secrets == 'true'` (i.e. when the
   `SUPABASE_TEST_URL` secret is set). If the secret is absent the job is
   *skipped*, which GitHub treats as passing — so it cannot block merge.
   Making it a **required status check** and configuring the four secrets are
   GitHub repo-settings actions a human must do; they are out of scope for the
   Coder. Implement the tests so they run in that job; do not touch branch
   protection. Mention this in `supabase/README.md` (a partial note already
   exists at the "In CI" line).

Everything else below is unambiguous. Do not invent additional scope.

---

## Background: what already exists (do NOT rebuild)

A working RLS integration harness is already in the repo. Reuse it as-is:

- `jest.config.integration.ts` — runner, `bun run test:rls`, `maxWorkers: 1`,
  `testMatch: **/tests/integration/rls/**/*.test.ts`. New test files under
  `tests/integration/rls/tables/` are auto-included. **No config change needed.**
- `tests/integration/rls/client.ts` — `getServiceClient()` (bypasses RLS,
  seed/verify only) and `getUserClient({ clerkId, churchGroupId?, appRole? })`
  (RLS-subject, mints JWT).
- `tests/integration/rls/jwt.ts` — `mintJwt`. No change.
- `tests/integration/rls/setup.ts` — `IDS` constants, `rlsTestsEnabled`,
  `globalSetup()`, `seedViaServiceClient()`.
- `tests/integration/rls/helpers.ts` — assertion helpers + `clients` personas.
- `supabase/seed-rls-test.sql` — canonical two-tenant seed (psql path).
- `.github/workflows/ci.yml` — `rls-integration` job applies migrations then runs
  `bun run test:rls`. **No change needed** (new test file is picked up by glob).

Two seeded tenants exist: **Church A** (adminA, leaderA, memberA, memberA2,
guestA) and **Church B** (memberB, adminB). RLS policies live in
`supabase/migrations/20260704000001_rls_policies.sql` and
`20260704000002_church_groups_rls.sql`.

## The gap this issue must close

Acceptance criterion 1 requires, **for every table**, a Church A JWT attempting
**all four verbs (SELECT / INSERT / UPDATE / DELETE)** on **Church B's rows**.
Current coverage:

- Cross-tenant **SELECT** and **INSERT**: covered for most Tier-1 tables in
  `tables/cross-tenant.test.ts` (direction is memberB→A, still valid).
- Cross-tenant **UPDATE** and **DELETE**: **missing for every table.**
- Several tables absent from the cross-tenant sweep: `member_instruments`,
  `song_documents`, `notifications`, plus Church-B-side rows do not exist for
  many tables, so there is nothing to attempt UPDATE/DELETE against.

Work: (a) seed a full Church B row for every table, (b) add two assertion
helpers, (c) add one new test file implementing the complete 19-table × 4-verb
bypass matrix from a Church A persona.

---

## The 19 tables in scope (issues #16–#21 = clusters 1–6)

church_groups, users, member_profiles, instruments, member_instruments,
service_weeks, setlists, setlist_songs, events, invitations, event_attendees,
conflicts, songs, song_documents, availability, notification_preferences,
notifications, google_calendar_tokens, audit_logs.

---

## Files to modify / create

### 1. `tests/integration/rls/setup.ts` — extend `IDS` and seed

Add Church-B (and a couple of missing A-side) IDs to the `IDS` object. Use these
exact UUIDs (they follow the existing per-table segment scheme and avoid
collisions):

```
memberProfiles.memberB:          "00000000-0000-4000-8004-000000000003"
memberInstruments.memberA:       "00000000-0000-4000-8004-000000000010"   // promote existing seed literal
memberInstruments.memberB:       "00000000-0000-4000-8004-000000000012"
invitations.memberB:             "00000000-0000-4000-800a-000000000003"
conflicts.B:                     "00000000-0000-4000-800b-000000000002"
availability.memberB:            "00000000-0000-4000-800c-000000000003"
notifications.memberB:           "00000000-0000-4000-800d-000000000002"
notificationPreferences.memberA: "00000000-0000-4000-800e-000000000001"   // promote existing seed literal
notificationPreferences.memberB: "00000000-0000-4000-800e-000000000002"
gCalTokens.memberB:              "00000000-0000-4000-8010-000000000002"
auditLogs.B:                     "00000000-0000-4000-800f-000000000002"
songDocuments.A:                 "00000000-0000-4000-8011-000000000001"   // promote existing seed literal
songDocuments.B:                 "00000000-0000-4000-8011-000000000002"
eventAttendees.A:                "00000000-0000-4000-8012-000000000001"
eventAttendees.B:                "00000000-0000-4000-8012-000000000002"
```

Add these to `IDS`. New sub-objects: `memberInstruments`, `songDocuments`,
`notificationPreferences`, `eventAttendees`. Existing sub-objects to extend with
a `.memberB`/`.B` key: `memberProfiles`, `invitations`, `conflicts`,
`availability`, `notifications`, `gCalTokens`, `auditLogs`.

In `seedViaServiceClient()` add these inserts (mirror the column sets already used
for the Church A rows in the same function; all use `svc.from(...).insert(...)`):

- **member_profiles**: `{ id: memberProfiles.memberB, user_id: users.memberB, vocal_capability: "lead" }`
- **member_instruments**: `{ id: memberInstruments.memberB, member_profile_id: memberProfiles.memberB, instrument_id: instruments.drumsB }`
- **invitations**: `{ id: invitations.memberB, church_group_id: churches.B, service_week_id: serviceWeeks.B1, user_id: users.memberB, status: "pending", response_token: "token-member-b-001" }`
- **conflicts**: `{ id: conflicts.B, church_group_id: churches.B, invitation_id: invitations.memberB }`
- **availability**: `{ id: availability.memberB, user_id: users.memberB, church_group_id: churches.B, date: "2026-07-06", is_available: true }`
- **notifications**: `{ id: notifications.memberB, church_group_id: churches.B, user_id: users.memberB, type: "set_invitation", title: "Church B notification" }`
- **notification_preferences**: `{ id: notificationPreferences.memberB, user_id: users.memberB }`
- **google_calendar_tokens**: same shape as memberA row but `id: gCalTokens.memberB, user_id: users.memberB, calendar_id: "cal-b@test.example"`
- **audit_logs**: `{ id: auditLogs.B, church_group_id: churches.B, user_id: users.adminB, action: "user.role_changed", entity_type: "user", entity_id: users.memberB }`
- **song_documents**: `{ id: songDocuments.B, song_id: songs.B1, church_group_id: churches.B, name: "Chord Chart B", file_key: "songs/chord-b1.pdf", file_type: "application/pdf", file_size_bytes: 2222 }`
- **event_attendees** (NEW insert block — none seeded today): `{ id: eventAttendees.A, event_id: events.A, user_id: users.memberA }` and `{ id: eventAttendees.B, event_id: events.B, user_id: users.memberB }`. Insert **after** events and users. Schema: `event_attendees(id, event_id, user_id)` only.

Where existing code uses inline literals (`notification_preferences` id, the
`member_instruments`/`song_documents` A literals in `rls.test.ts`), keep them
working by referencing the promoted `IDS.*` constants; do not break existing rows.

### 2. `supabase/seed-rls-test.sql` — mirror the same new rows

Add the identical Church B rows (and the two `event_attendees` rows) as SQL
`INSERT` statements in the matching sections, using the same UUIDs and columns.
`event_attendees` is already in the file's `TRUNCATE ... CASCADE` header. Both
seed paths (`seedViaServiceClient()` and this SQL) must produce identical data.

### 3. `tests/integration/rls/helpers.ts` — add two helpers

Add these two exported functions. They verify a write had NO effect, tolerating
either the silent-filter outcome (no error, 0 rows) OR a hard privilege error —
both mean "bypass blocked". They use a service client to confirm ground truth.

```ts
/**
 * Assert a cross-tenant UPDATE is a no-op: the target row's patched columns are
 * unchanged when read back via the service client. Tolerates both a silent
 * 0-row update and a hard RLS/privilege error.
 */
export async function assertUpdateNoOp(
  userClient: SupabaseClient,
  serviceClient: SupabaseClient,
  table: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<void>;

/**
 * Assert a cross-tenant DELETE is a no-op: the target row still exists when read
 * back via the service client. Tolerates both a silent 0-row delete and an error.
 */
export async function assertDeleteNoOp(
  userClient: SupabaseClient,
  serviceClient: SupabaseClient,
  table: string,
  id: string,
): Promise<void>;
```

Implementation requirements:

- `assertUpdateNoOp`: read the row via `serviceClient.from(table).select("*").eq("id", id).single()` BEFORE; run `userClient.from(table).update(patch).eq("id", id)` (ignore its error — a hard error is an acceptable block); re-read via serviceClient; for every key in `patch`, assert the re-read value equals the BEFORE value (the patched column did not change to the attempted value).
- `assertDeleteNoOp`: run `userClient.from(table).delete().eq("id", id)` (ignore error); then `serviceClient.from(table).select("id").eq("id", id)`; assert exactly one row returned (row survived).
- Reuse existing `assertInsertDenied` (INSERT must return an error) and `assertSelectBlocked` (SELECT returns 0 rows or error). Do not duplicate them.

### 4. `tests/integration/rls/tables/cross-tenant-bypass.test.ts` — NEW file

Canonical AC-1 matrix. Copy the skeleton from
`tests/integration/rls/tables/cross-tenant.test.ts`: same imports, the
`const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;` /
`const describeRls = skip ? describe.skip : describe;` guard, and a `beforeAll`
that calls `seedViaServiceClient()` and captures `serviceClient = getServiceClient()`.

Attacker persona is **Church A** — `getUserClient({ clerkId: IDS.clerkIds.memberA })`.
For tables where only an elevated role could ever write (setlists, invitations,
conflicts, audit_logs), ALSO run the INSERT/UPDATE/DELETE attempts as `adminA`
(`IDS.clerkIds.adminA`) to prove even a privileged Church A user cannot cross
tenants. All targets are Church B rows/ids from the seed.

For **each of the 19 tables**, add a `describe(tableName, ...)` with:

- **SELECT blocked**: `assertSelectBlocked(attacker, table, <filter targeting Church B>)` — 0 rows. Filter by `church_group_id: IDS.churches.B` for Tier-1 tables; by the specific Church B row `id` for Tier-2/Tier-3 tables (member_profiles, member_instruments, setlist_songs, event_attendees, notification_preferences, google_calendar_tokens).
- **INSERT denied**: `assertInsertDenied(attacker, table, <row referencing Church B>)` — expect an error.
- **UPDATE no-op**: `assertUpdateNoOp(attacker, serviceClient, table, <Church B row id>, <patch>)`.
- **DELETE no-op**: `assertDeleteNoOp(attacker, serviceClient, table, <Church B row id>)`.

Per-table target id / INSERT row / UPDATE patch:

| table | target id | INSERT row (Church B) | patch |
|---|---|---|---|
| church_groups | `IDS.churches.B` | `{ name:"Evil", timezone:"UTC", invite_code:"EVIL" }` (no id) | `{ name:"Hacked" }` |
| users | `IDS.users.memberB` | `{ clerk_id:"evil", church_group_id:IDS.churches.B, role:"member", name:"Evil", email:"evil@test.example" }` | `{ name:"Hacked" }` |
| member_profiles | `IDS.memberProfiles.memberB` | `{ user_id:IDS.users.memberB, vocal_capability:"lead" }` | `{ vocal_capability:"harmony" }` |
| instruments | `IDS.instruments.drumsB` | `{ church_group_id:IDS.churches.B, name:"Evil", is_default:false }` | `{ name:"Hacked" }` |
| member_instruments | `IDS.memberInstruments.memberB` | `{ member_profile_id:IDS.memberProfiles.memberB, instrument_id:IDS.instruments.drumsB }` | `{ instrument_id:IDS.instruments.pianoA }` |
| service_weeks | `IDS.serviceWeeks.B1` | `{ church_group_id:IDS.churches.B, service_date:"2026-09-01", title:"Evil" }` | `{ title:"Hacked" }` |
| setlists | `IDS.setlists.publishedB` | `{ church_group_id:IDS.churches.B, service_week_id:IDS.serviceWeeks.B1, status:"draft" }` (also adminA) | `{ status:"draft" }` |
| setlist_songs | `IDS.setlistSongs.publishedB` | `{ setlist_id:IDS.setlists.publishedB, song_id:IDS.songs.B1, position:99 }` | `{ position:99 }` |
| events | `IDS.events.B` | `{ church_group_id:IDS.churches.B, service_week_id:IDS.serviceWeeks.B1, type:"rehearsal", name:"Evil", start_time:"2026-09-01T09:00:00Z", end_time:"2026-09-01T10:00:00Z" }` | `{ name:"Hacked" }` |
| invitations | `IDS.invitations.memberB` | `{ church_group_id:IDS.churches.B, service_week_id:IDS.serviceWeeks.B1, user_id:IDS.users.memberB, status:"pending", response_token:"evil-tok" }` (also adminA) | `{ status:"accepted" }` |
| event_attendees | `IDS.eventAttendees.B` | `{ event_id:IDS.events.B, user_id:IDS.users.memberB }` | `{ user_id:IDS.users.memberA }` |
| conflicts | `IDS.conflicts.B` | `{ church_group_id:IDS.churches.B, invitation_id:IDS.invitations.memberB }` (also adminA) | `{ trigger_reason:"hacked" }` |
| songs | `IDS.songs.B1` | `{ church_group_id:IDS.churches.B, title:"Evil", artist:"Evil" }` | `{ title:"Hacked" }` |
| song_documents | `IDS.songDocuments.B` | `{ song_id:IDS.songs.B1, church_group_id:IDS.churches.B, name:"Evil", file_key:"x", file_type:"application/pdf", file_size_bytes:1 }` | `{ name:"Hacked" }` |
| availability | `IDS.availability.memberB` | `{ user_id:IDS.users.memberB, church_group_id:IDS.churches.B, date:"2026-09-01", is_available:true }` | `{ is_available:false }` |
| notification_preferences | `IDS.notificationPreferences.memberB` | `{ user_id:IDS.users.memberB }` | `{ invitation_sms:false }` |
| notifications | `IDS.notifications.memberB` | `{ church_group_id:IDS.churches.B, user_id:IDS.users.memberB, type:"set_invitation", title:"Evil" }` | `{ is_read:true }` |
| google_calendar_tokens | `IDS.gCalTokens.memberB` | `{ user_id:IDS.users.memberB, access_token_encrypted:"x", refresh_token_encrypted:"y", token_expiry:"2027-01-01T00:00:00Z", calendar_id:"evil@test.example", scope:"https://www.googleapis.com/auth/calendar" }` | `{ calendar_id:"hacked@test.example" }` |
| audit_logs | `IDS.auditLogs.B` | `{ church_group_id:IDS.churches.B, user_id:IDS.users.memberB, action:"evil", entity_type:"x", entity_id:IDS.churches.B }` (also adminA) | `{ action:"hacked" }` |

For any patch column you are unsure exists, prefer a column already written by the
seed for that table (guaranteed to exist). Do not add columns to any table.

### 5. `supabase/README.md` — small doc touch

Under the existing "RLS Integration Tests (#33)" section, add one sentence noting
that `tables/cross-tenant-bypass.test.ts` is the canonical four-verb
(SELECT/INSERT/UPDATE/DELETE) cross-tenant matrix and must be extended with a new
`describe` block (and Church B seed row) whenever a new table is added in later
sprints. Reinforces the issue's "extend, not replace" implementation note.

---

## Edge cases the implementation MUST handle

1. **Cross-tenant UPDATE/DELETE do NOT error — they silently affect 0 rows.** The
   RLS `USING` clause filters the target row out, so `.update()`/`.delete()`
   return `{ error: null }`. Asserting `error != null` would be WRONG. Always
   verify via the service client that the row is unchanged / still present. The
   `assertUpdateNoOp` / `assertDeleteNoOp` helpers encapsulate this.
2. **Some tables hard-error instead of no-op** (e.g. `audit_logs` UPDATE/DELETE are
   REVOKEd → privilege error 42501). The no-op helpers must tolerate an error AND
   still confirm the row is unchanged — do not assert error is null there.
3. **INSERT is the opposite**: cross-tenant INSERT is rejected by `WITH CHECK` (or
   absence of an INSERT policy) and returns an error (42501). Use
   `assertInsertDenied` (expects error present). A `23505` unique-violation is a
   different failure — do not rely on unique collisions; use fresh non-colliding
   values (no `id`) so the only possible rejection is RLS.
4. **church_groups has no INSERT/UPDATE/DELETE policy at all** → all writes denied
   by RLS default. SELECT of Church A's group by a Church B user returns 0 rows
   (policy `church_groups_select_own`).
5. **Tier-3 tables (`notification_preferences`, `google_calendar_tokens`) have no
   `church_group_id`.** "Church B's row" = memberB's row. Filter/target by `id` or
   `user_id: IDS.users.memberB`.
6. **`member_instruments` / `event_attendees` are pure join rows** with no
   descriptive mutable column. For their UPDATE test, patch a FK column and assert
   it is unchanged (the row is filtered out, so nothing changes).
7. **Suite must stay skippable.** Keep the `skip`/`describe.skip` guard so
   `bun run test` (unit) and CI without secrets do not attempt live DB calls.
8. **Sequential + shared seed.** `maxWorkers: 1` is already set. `beforeAll` must
   call `seedViaServiceClient()` (idempotent: deletes-then-inserts). The bypass
   tests are no-ops by design, so they create no cleanup burden; INSERT attempts
   error and insert nothing.

## Patterns to copy from

- Test skeleton, skip guard, persona clients, `beforeAll` seeding:
  `tests/integration/rls/tables/cross-tenant.test.ts`.
- Silent-no-op UPDATE verification via service client:
  `tests/integration/rls/tables/users.test.ts` ("silently affects 0 rows" tests)
  and `availability.test.ts`.
- Seed row shapes / column sets: existing inserts in
  `tests/integration/rls/setup.ts` `seedViaServiceClient()` and
  `supabase/seed-rls-test.sql`.
- Helper style: existing exports in `tests/integration/rls/helpers.ts`.

## Definition of done

- `tables/cross-tenant-bypass.test.ts` exists with a `describe` per all 19 tables,
  each running SELECT/INSERT/UPDATE/DELETE from Church A against Church B rows and
  asserting no data leak / no mutation.
- `seedViaServiceClient()` and `supabase/seed-rls-test.sql` both seed a full Church
  B row for every table plus `event_attendees` A+B, with matching UUIDs.
- `IDS` in `setup.ts` exposes every referenced id.
- `helpers.ts` exports `assertUpdateNoOp` and `assertDeleteNoOp`.
- `bun run typecheck` passes; `bun run test` (unit) is unaffected (integration
  suite skips without env vars); `bun run test:rls` passes against a live seeded
  Supabase test instance.
