# Changes — Issue #69: Wire notification trigger logic for all Phase 1 event types

Implements spec.md §1–§7 plus the two OPEN QUESTIONS, which the operator
**resolved on 2026-08-31** — the resolutions are recorded in `.pipeline/spec.md`
as `> RESOLUTION` blocks (OQ1 practice reminders: build here, per-user
`reminder_hours_before` lead time, split selector/marker RPCs for safety; OQ2
Google Calendar event email: approved copy + material-change/attendee-assign
triggers, email-only).

## Deploy notes (read before rolling out)

- **Migration apply order:** apply `20260831000001_notification_trigger_dispatch.sql`
  **before** deploying this code. `send_invitation_reminders()` changes from a
  bare array to `{ member_reminders, admin_reminders }`; the cron route tolerates
  both shapes for one release, but applying the migration first avoids the
  array-shaped window. `20260831000002_practice_reminder_scheduler.sql` is
  additive and can apply any time before the practice-reminders workflow is enabled.
- **Seed the cron secret before enabling the practice-reminders workflow.** The
  two practice-reminder RPCs are gated on `CRON_SECRET` matched against a
  `public.app_secrets` row that a migration **cannot** contain. After deploy, run
  once (service role / SQL editor):
  `insert into public.app_secrets (key, value) values ('cron_secret', '<the CRON_SECRET value>') on conflict (key) do update set value = excluded.value;`
  Until then `send_practice_reminders` raises `FORBIDDEN` and the cron 500s
  (fail-closed — intended).
- **Fresh apply only.** `20260831000002` uses a bare `CREATE TABLE
  public.practice_reminder_sends`. An earlier iteration of this PR's migration is
  not on any deployed environment, but if one were, drop
  `practice_reminder_sends` (and the three functions) before applying — the
  column set changed.
- **`NEXT_PUBLIC_APP_URL` is load-bearing.** It must be set to an absolute
  `https://…` origin in every deploy environment. When unset, `appNotificationUrl`
  returns a site-relative path, `renderEmailTemplate` rejects it, and **every**
  notification email silently becomes `emailFailed` (SMS still sends). Tested
  (edge case 8) — not a crash, but no emails.
- **Practice-reminder email is opt-in until #70.** The scheduler reads
  `notification_preferences.reminder_email`, which defaults to **false**, so no
  practice-reminder emails go out until a member enables it (the toggle UI is
  #70). SMS (`reminder_sms` default true, plus `users.sms_opted_in`) works out of
  the box.
- **Accepted risk (review M2):** `deny_invitation()` returns admin contact rows
  (name/email/phone) in its result. The RPC is `anon`-granted and
  response-token-authorized, so a token holder can call it directly and read the
  inviting admin's (or, on the `invited_by IS NULL` path, all admins')
  contact details. Accepted for Phase 1; documented in the migration header.
- **Follow-up:** `send_invitation_reminders()` is still `anon`-granted with a
  write side effect (`last_reminded_at`); its blast radius is bounded (24h defer,
  designed to re-send) so it is not fixed here, but it should get the same
  `CRON_SECRET` gate in a hardening pass.

## New files

### `lib/notifications/dispatch.ts`
The shared SMS + Email fan-out helper every trigger path calls.
- `dispatchNotification({ recipients, sms?, email? })` — **never throws**; dedupes
  recipients by `userId` (first wins); sequential sends; maps sendSms
  `sent`/`skipped`/thrown → `smsSent`/`smsSkipped`/`smsFailed`; email `null`/blank
  → `emailSkipped` (no call), thrown → `emailFailed`. `console.error` on failure
  logs `userId` + error only (PRD §25.6).
- `appNotificationUrl(path)` — mirrors the `appUrl` helper in the invitations
  handler (NEXT_PUBLIC_APP_URL, trailing slashes stripped, site-relative when unset).

### `lib/notifications/event-email.ts` (OQ2)
- `formatEventWhen(startTime)` — pure UTC-anchored `{ dayDate, time }` formatter.
- `dispatchGoogleCalendarEventEmail(supabase, params)` — best-effort, never throws.
  Emails the **members assigned to the event** (`event_attendees` for
  `params.eventId`) or an explicit `recipientUserIds` list — the same set the
  GCal sync writes to, so "Your Google Calendar has been updated" is true for
  every recipient (review MJ1). The `users` contact lookup is tenant-scoped
  (`.eq("church_group_id", …)`, review LOW-1). Uses the `google_calendar_event`
  template (copy approved 2026-08-31, added to PRD §30). **Email only**.

### `app/api/cron/practice-reminders/route.ts` (OQ1)
New hourly cron route, CRON_SECRET bearer auth. Calls
`send_practice_reminders(CRON_SECRET)`, which **claims** each due pair; dispatches
only the channels that are enabled for that user AND not already `*_done`
(`reminder_sms` / `reminder_email`); then calls
`confirm_practice_reminder_sent(CRON_SECRET, event, user, smsChannelDone,
emailChannelDone)` with each channel's outcome. Reports a `confirmed` counter. A
hard-failed channel is retried next run without re-sending the one that
succeeded (bounded to 3 attempts).

### `.github/workflows/practice-reminders-cron.yml` (OQ1)
Copy of `invitation-reminders-cron.yml`, hourly, hits `/api/cron/practice-reminders`.

### `supabase/migrations/20260831000001_notification_trigger_dispatch.sql`
`CREATE OR REPLACE` only — no schema changes:
- `send_invitation_reminders()` now returns `{ member_reminders, admin_reminders }`
  (was a bare array). `admin_reminders` = one entry per (service week ×
  admin/set_leader) with contact columns + `pending_count`, accumulated in the
  existing notification loop.
- `deny_invitation()` success return gains `member_name`, `service_week_id`,
  `service_date`, `week_title`, `reason`, `recipients[]` (contact rows for the
  same admin set the in-app notify loop uses). Already-responded early return
  gains `recipients: []`. `v_member_name` is now `coalesce(…, 'A member')`
  (review N5) so a null name never produces `" declined their set invitation"`.
- Header documents the review-M2 accepted risk and the migration apply order.

### `supabase/migrations/20260831000002_practice_reminder_scheduler.sql` (OQ1)
- New `public.app_secrets` (`key`, `value`) — RLS on, **no policy**, and
  `REVOKE ALL … FROM PUBLIC, anon, authenticated` (belt-and-braces, cf.
  `audit_logs`). Only SECURITY DEFINER functions read it. Seeded out-of-band.
- New `practice_reminder_sends` **claim/confirm ledger**: `(event_id, user_id)`
  unique, `claimed_at`, **`sms_done`**, **`email_done`**, `attempts`. RLS on, no
  policy, REVOKE'd.
- `assert_cron_secret(secret)` — raises `FORBIDDEN` unless the secret matches
  the `app_secrets` row; `REVOKE`d from `PUBLIC`, inlined by the two RPCs below.
- **`send_practice_reminders(p_cron_secret)`** (`SECURITY DEFINER`): asserts the
  secret; selects **up to 100** due pairs — per-user `reminder_hours_before` lead
  time, ordered soonest-first, excluding pairs whose enabled channels are all
  done / claimed in the last 90 min / already tried 3× — and **claims** them
  (`INSERT … ON CONFLICT DO UPDATE … WHERE` the freshness guard still holds,
  `RETURNING` only rows this run claimed, so overlapping runs don't
  double-send). Returns each row plus `reminder_sms` / `reminder_email` /
  `sms_done` / `email_done`.
- **`confirm_practice_reminder_sent(p_cron_secret, event, user, p_sms_done,
  p_email_done)`** (`SECURITY DEFINER`): asserts the secret; OR-merges the
  per-channel done flags; returns whether the row changed.
- Review B2 / B2-R1 / B2-R2 / M3 / MED-1..3: the secret gate makes the write
  path unreachable without `CRON_SECRET` (fixes the permanent-suppression DoS);
  the per-channel flags mean a Resend-only outage retries **email only** (SMS is
  not re-sent); 90-min claim expiry + 3-attempt cap bounds retries; `LIMIT 100`
  drains a backlog across runs instead of claiming-then-dropping on a timeout.

### New test files
- `tests/unit/lib/notifications/dispatch.test.ts` — edge cases 1-8, 15.
- `tests/unit/lib/notifications/event-email.test.ts` — OQ2 module.
- `tests/unit/app/api/invitations-route-notifications.test.ts` — §2a/§2b, edge 12/14.
- `tests/unit/app/api/invitations-deny-route-notifications.test.ts` — §4a/§4b, edge 9/10, invited_by-null fan-out, **N5 fallback (both paths)**.
- `tests/unit/app/api/setlists-publish-notifications.test.ts` — §5, edge 4/11.
- `tests/unit/app/api/availability-conflict-notifications.test.ts` — §6, edge 13.
- `tests/unit/app/api/cron-invitation-reminders-admin-sms.test.ts` — §3c.
- `tests/unit/app/api/cron-practice-reminders-route.test.ts` — OQ1 route: secret
  passthrough, per-user channel choice, both-disabled still confirms, confirm
  called only on clean dispatch, `confirmed` counter.
- `tests/unit/app/api/events-notification-gcal.test.ts` — OQ2 handler gating.
- `tests/unit/lib/notifications/event-email.test.ts` — recipients default to
  `event_attendees` (review MJ1).

## Modified files

- `app/api/invitations/handler.ts` — §2a `createInvitation`, §2b
  `createGuestInvitation` (hoisted `inviteUrl`/`accountSetupUrl`), §4a
  `denyInvitation` authenticated path, §4b token path. Each dispatch block
  wrapped in a defensive try/catch. `memberName` fallbacks are now `"A member"`
  (review N5) at both deny paths.
- `app/api/cron/invitation-reminders/route.ts` — §3c: reads the new RPC object
  shape, **tolerates the old bare-array shape for one release** (review M1),
  adds the admin SMS loop (SMS only), adds `adminNotified` to the response.
- `app/api/setlists/[id]/handler.ts` — §5 `publishSetlist`: SMS + Email fan-out to
  confirmed members after the in-app insert.
- `lib/scheduling/conflict-detection.ts` — §6a: new `dispatchConflictNotifications`
  export (best-effort, never throws). `recordAvailabilityConflict` unchanged.
  `memberName` fallback is `"A member"` (review MN1 / N5).
- `app/api/availability/handler.ts` — §6b: fires `dispatchConflictNotifications`
  from `setAvailability` and `deleteAvailability` when a conflict was recorded.
- `app/api/events/[id]/handler.ts` — OQ2: `updateEvent` fires the GCal email only
  on a material change (start_time / end_time / location), to that event's
  `event_attendees` (review MJ1).
- `app/api/events/[id]/attendees/handler.ts` — OQ2: `assignAttendee` emails the
  newly-assigned member (passes `eventId`).
- `lib/resend/templates.ts` — `google_calendar_event` template key + data map
  + `buildContent` case. Copy **approved 2026-08-31** (spec.md OQ2 resolution).
- `lib/supabase/types.ts` — updated `send_invitation_reminders` / `deny_invitation`
  return types; updated `PracticeReminderSendsRow` (claim/confirm columns); added
  `app_secrets` table + `AppSecretsRow`; added `send_practice_reminders(p_cron_secret)`
  + `confirm_practice_reminder_sent` function types.
- `documentation/prd/graceful_requirements_v10.md` — §30: `Google Calendar event`
  copy row, marked approved 2026-08-31.
- `tests/e2e/invitation-deny.spec.ts` — §7: comment + skipped-test-title update
  only (no logic change, still skipped).
- Existing tests updated for the new RPC object contract / new template key /
  N5 fallback: `cron-invitation-reminders-route.test.ts` (+ 2 supplements),
  `cron-practice-reminders-route.test.ts`, `invitations-deny-route-notifications.test.ts`,
  `tests/unit/lib/resend/templates.test.ts`.

## What the Tester / Reviewer should focus on

- **Invitation accepted is a no-regression case**: PRD channel is in-app only; no
  code touches `accept_invitation`.
- **SQL is not executed by the suite.** Confirm by hand: `assert_cron_secret`
  fail-closed; the `send_practice_reminders` claim `RETURNING` only surfaces
  rows this run actually claimed (concurrency); the 90-min / 3-attempt guard is
  applied both in the selector and the `DO UPDATE … WHERE`; the route skips
  `confirm_practice_reminder_sent` when a channel hard-fails.
- **M1 back-compat**: an array-shaped `send_invitation_reminders` result still
  drives the member loop.
- **Best-effort guarantee**: every trigger returns its normal 2xx even when the
  whole dispatch (or the recipient lookup) fails.
- **GCal email gating**: fires on start/end/location change + attendee assign;
  NOT on bare create or notes/name-only edits.
