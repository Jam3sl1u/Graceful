# Changes — Issue #45: 24-hour dual-party invitation reminder scheduler

Implemented exactly per `.pipeline/spec.md`. No scope creep beyond the 8
files it names.

## Files changed

1. **`supabase/migrations/20260713000001_invitation_reminder_scheduler.sql`** (new)
   - Adds `invitations.last_reminded_at timestamptz` + partial index
     `idx_invitations_pending_reminder` (`WHERE status = 'pending'`).
   - Adds `public.send_invitation_reminders()` — `SECURITY DEFINER`,
     `SET search_path = ''`, mirrors the `accept_invitation` RPC's shape.
     Selects due invitations (`status = 'pending'` AND
     `coalesce(last_reminded_at, created_at) <= now() - 24h` AND parent
     `service_weeks.is_cancelled = false`) into a temp table, builds and
     returns the JSON member-reminder array, inserts one admin/set_leader
     notification per affected service week (D2 aggregation — lists ALL
     currently-pending members for that week by name, not just the due
     ones), and stamps `last_reminded_at = now()` only on the due rows.
     `GRANT EXECUTE ... TO anon, authenticated` + commented DOWN block.
   - `invitation_reminder` notification type already existed
     (`20260702000005_cluster_5_partial.sql`) — not re-added.

2. **`lib/supabase/types.ts`** (modified)
   - `InvitationsRow` gains `last_reminded_at: string | null`.
   - `invitations` table `Insert` type: added `last_reminded_at` to the
     `Omit<...>` union and as an optional `last_reminded_at?: string | null`
     override (DB-defaulted to NULL).
   - `Database["public"]["Functions"]` gains `send_invitation_reminders`
     with `Args: Record<string, never>` and the `Returns` array shape from
     the spec.

3. **`lib/scheduling/reminder.ts`** (new) — pure, unit-testable helpers:
   - `REMINDER_INTERVAL_MS` (24h in ms).
   - `isReminderDue(invitation, now)` — mirrors the SQL selector exactly
     (comment cross-references the migration so the two stay in sync).
   - `buildMemberReminderSms(memberName, weekLabel)` — short SMS copy.
   - `formatWeekLabel(title, serviceDate)` — title if present, else
     `serviceDate` formatted as `Mon DD, YYYY` (UTC), matching the SQL's
     `to_char(week.service_date, 'Mon DD, YYYY')` used in the admin body.

4. **`app/api/cron/invitation-reminders/route.ts`** (new) — `GET` only
   (Vercel Cron). Contract exactly as spec'd:
   - `CRON_SECRET` unset → 500 `INTERNAL` (checked before any DB call).
   - `Authorization` header not exactly `Bearer ${CRON_SECRET}` → 401
     `UNAUTHENTICATED`.
   - Calls `send_invitation_reminders` via `getAnonSupabaseClient()`; RPC
     error → 500 `INTERNAL`.
   - For each reminder: dispatches `sendSms` (from `lib/pingram/client.ts`,
     currently a throwing stub) only when `phone` is non-null AND
     `sms_opted_in === true`; failures are caught per-reminder
     (`smsFailed` counter + `console.error`) and never fail the job.
     Members without phone/opt-in are counted as `smsSkipped`, not
     `smsFailed`.
   - Returns `ok({ processed, smsSent, smsSkipped, smsFailed })`.

5. **`vercel.json`** (new) — registers the cron:
   `{ "crons": [{ "path": "/api/cron/invitation-reminders", "schedule": "0 * * * *" }] }`.

6. **`app/api/invitations/handler.ts`** (modified — comment only) —
   replaced the `TODO(#45/#36)` in `withdrawInvitation` with a comment
   explaining cancellation is automatic (D1: the reminder selector filters
   `status = 'pending'`, so the withdraw's status flip already stops future
   reminders). No logic changed in this file.

7. **`tests/unit/lib/scheduling/reminder.test.ts`** (new) — mocked-time
   (`Date` fixtures, no real waiting) coverage of `isReminderDue`'s 6 cases
   from the spec (first reminder at exactly 24h, just-under-threshold,
   over-threshold, recent repeat-reminder not due, repeat-reminder due,
   and all three non-pending statuses never due — D1), plus
   `buildMemberReminderSms` and `formatWeekLabel` (title vs. formatted
   date).

8. **`tests/unit/app/api/cron-invitation-reminders-route.test.ts`** (new)
   — mirrors the `invitations-withdraw-route.test.ts` mock-scaffolding
   style, mocking `@/lib/supabase/client` and `@/lib/pingram/client`.
   Covers: 401 on missing/wrong Authorization header (RPC never called),
   500 on unset `CRON_SECRET`, 500 on RPC error, happy path (2 reminders,
   1 dispatched/1 skipped, correct counts), `sendSms` rejection isolated
   (still 200, `smsFailed: 1`), and the empty/no-due-invitations case
   (`processed: 0`, no SMS calls).

## Out of scope (per spec, not touched)

- No real SMS/email dispatch — `sendSms` stub only.
- No configurable per-week response deadlines.
- No cancellation table / scheduler-state store (D1: automatic).
- No changes to accept/deny/withdraw logic beyond the one comment in §6.

## Verification run

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 33 suites / 398 tests passed (all pre-existing tests
  still pass; the 2 new suites above pass).
- `bun run check:service-role` — clean (the new cron route/RPC caller use
  `getAnonSupabaseClient()`, never the service-role key).
- `bun run check:workflows` — clean (no orchestration scripts touched).
- Migration SQL itself has no live-DB harness in this repo (same as
  `accept_invitation`); its correctness is covered by the route/helper unit
  tests that mock the RPC's return value, per the spec's instruction not to
  add a live-DB test.

## What the Tester should focus on

- `lib/scheduling/reminder.ts`'s `isReminderDue` boundary conditions
  (exactly-24h, just-under, non-pending statuses) since the SQL selector in
  the migration can't be exercised directly in this repo's test harness —
  the unit tests here are the primary correctness signal for that logic.
- The cron route's auth ordering (`CRON_SECRET`-unset check happens before
  any DB call) and that a `sendSms` rejection never surfaces as a non-200
  response.
- D2 aggregation (one admin notification per admin per affected week,
  listing all currently-pending members) is implemented only in the SQL
  RPC body, which has no live-DB test in this repo — review the migration
  SQL directly for correctness (temp table + `string_agg` + per-week loop).
