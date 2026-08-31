# Changes — Issue #69: Wire notification trigger logic for all Phase 1 event types

Implements spec.md §1–§7 plus the human-resolved OPEN QUESTIONS (OQ1 practice
reminders, OQ2 Google Calendar event email).

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
  Emails confirmed members (accepted invitations for the week) or an explicit
  `recipientUserIds` list, using the new `google_calendar_event` template.
  **Email only** (PRD channel is "Email + GCal", no SMS).

### `app/api/cron/practice-reminders/route.ts` (OQ1)
New hourly cron route, CRON_SECRET bearer auth, mirrors the invitation-reminders
route. Calls the `send_practice_reminders` RPC and dispatches SMS + Email for
each returned row (per-user lead time + idempotency all handled in the RPC).

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
  gains `recipients: []`.

### `supabase/migrations/20260831000002_practice_reminder_scheduler.sql` (OQ1)
- New `practice_reminder_sends` table `(event_id, user_id)` unique — per-(event,user)
  idempotency ledger; RLS enabled, no policy (SECURITY DEFINER RPC bypasses as owner).
- New `send_practice_reminders()` SECURITY DEFINER RPC (granted to anon): resolves
  (future event × confirmed member) pairs whose per-user
  `notification_preferences.reminder_hours_before` (default 24) lead time is
  reached and not yet sent, inserts the marker rows, returns only the rows this
  call inserted (self-throttling).

### New test files
- `tests/unit/lib/notifications/dispatch.test.ts` — edge cases 1-8, 15.
- `tests/unit/lib/notifications/event-email.test.ts` — OQ2 module.
- `tests/unit/app/api/invitations-route-notifications.test.ts` — §2a/§2b, edge 12/14.
- `tests/unit/app/api/invitations-deny-route-notifications.test.ts` — §4a/§4b, edge 9/10, invited_by-null fan-out.
- `tests/unit/app/api/setlists-publish-notifications.test.ts` — §5, edge 4/11.
- `tests/unit/app/api/availability-conflict-notifications.test.ts` — §6, edge 13.
- `tests/unit/app/api/cron-invitation-reminders-admin-sms.test.ts` — §3c.
- `tests/unit/app/api/cron-practice-reminders-route.test.ts` — OQ1 route.
- `tests/unit/app/api/events-notification-gcal.test.ts` — OQ2 handler gating.

## Modified files

- `app/api/invitations/handler.ts` — §2a `createInvitation`, §2b
  `createGuestInvitation` (hoisted `inviteUrl`/`accountSetupUrl`), §4a
  `denyInvitation` authenticated path, §4b token path. Each dispatch block is
  wrapped in a defensive try/catch so a lookup/dispatch failure never changes
  the success status.
- `app/api/cron/invitation-reminders/route.ts` — §3c: reads the new RPC object
  shape, adds the admin SMS loop (SMS only), adds `adminNotified` to the response.
- `app/api/setlists/[id]/handler.ts` — §5 `publishSetlist`: SMS + Email fan-out to
  confirmed members after the in-app insert.
- `lib/scheduling/conflict-detection.ts` — §6a: new `dispatchConflictNotifications`
  export (best-effort, never throws). `recordAvailabilityConflict` unchanged.
- `app/api/availability/handler.ts` — §6b: fires `dispatchConflictNotifications`
  from `setAvailability` and `deleteAvailability` when a conflict was recorded.
- `app/api/events/[id]/handler.ts` — OQ2: `updateEvent` fires the GCal email only
  on a material change (start_time / end_time / location).
- `app/api/events/[id]/attendees/handler.ts` — OQ2: `assignAttendee` emails the
  newly-assigned member.
- `lib/resend/templates.ts` — new `google_calendar_event` template key + data map
  + `buildContent` case. **PROPOSED COPY — REQUIRES HUMAN APPROVAL** (marked in
  code + PR).
- `lib/supabase/types.ts` — updated `send_invitation_reminders` / `deny_invitation`
  return types; added `practice_reminder_sends` table + `send_practice_reminders`
  function types + `PracticeReminderSendsRow`.
- `documentation/prd/graceful_requirements_v10.md` — §30: added the
  `Google Calendar event` copy row, flagged **PROPOSED COPY — REQUIRES HUMAN APPROVAL**.
- `tests/e2e/invitation-deny.spec.ts` — §7: comment + skipped-test-title update
  only (no logic change, still skipped).
- Updated existing tests whose fixtures modelled the old `send_invitation_reminders`
  array contract / the old template-key list:
  `cron-invitation-reminders-route.test.ts` (+ 2 supplements),
  `tests/unit/lib/resend/templates.test.ts`.

## What the Tester should focus on

- **Invitation accepted is a no-regression case**: PRD channel is in-app only; no
  code touches `accept_invitation`. Confirm no SMS/email was added there.
- **`deny_invitation` / `send_invitation_reminders` RPC shape change** — the SQL
  is unverifiable without a live DB. Check the migration logic (admin_reminders
  accumulation inside the existing loop; recipients array matching the in-app
  notify set; already-responded early return carries `recipients: []`).
- **Best-effort guarantee**: every trigger must return its normal 2xx even when
  the whole dispatch (or the recipient lookup) fails.
- **OQ copy is PROPOSED**: the `google_calendar_event` subject/preview and the new
  PRD §30 row need human sign-off — they are drafts.
- **`send_practice_reminders` SQL**: per-user lead-time interval arithmetic, the
  DISTINCT ON dedupe, and the "return only rows this call inserted" self-throttle.
- **GCal email gating**: fires on start/end/location change + attendee assign;
  NOT on bare create or notes/name-only edits.
