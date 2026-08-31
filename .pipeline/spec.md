# Spec — Issue #69: Wire notification trigger logic for all Phase 1 event types

Branch: issue-69 worktree. PRD trigger table = `documentation/prd/graceful_requirements_v10.md`
§14 (lines 435-447; the issue calls it "§6.9"). Copy templates = §30 (lines 1696-1707).

---

## OPEN QUESTIONS (blocking — downstream stages must stop here)

Six of the eight notification types are fully specified below and ready to implement.
Two cannot be specified without a human decision:

### OQ1 — "Practice reminder" has no scheduling infrastructure at all

PRD §14: `Practice reminder | Confirmed members | SMS + Email | Configurable lead time
before each event (24hr, 2hr, etc.)`.

Current state: `practiceReminderSms` (`lib/notifications/sms-templates.ts:91`) and the
`practice_reminder` email template (`lib/resend/templates.ts:135`) both exist, but **nothing
calls them and no trigger exists to wire up**. Specifically, there is:

- no cron route (`app/api/cron/` contains only `invitation-reminders/`),
- no GitHub Actions workflow other than `.github/workflows/invitation-reminders-cron.yml`,
- no "reminder already sent" marker on `events` (see the table DDL,
  `supabase/migrations/20260702000003_cluster_3_scheduling_core.sql:60-74`) and no
  per-(event, user) sent-marker table, so nothing can make sends idempotent across hourly runs,
- no agreed lead-time source: the only one in the schema is per-user
  `notification_preferences.reminder_hours_before` (default 24, see
  `schemas/notifications.ts:16`), and reading it to decide *when* to fire is arguably the
  "Notification preferences enforcement" that this issue's Out of Scope section explicitly
  defers to #70. A per-user lead time also rules out a single `events.reminder_sent_at`
  column, forcing a new table.

This is a scheduler design task, not "connect the dots". **Decision needed:** either
(a) descope practice reminder from #69 into its own issue, or (b) approve building a new
cron route + workflow + schema for sent-tracking here, and state whether the lead time is a
fixed 24h for now or per-user `reminder_hours_before`.

### OQ2 — "Google Calendar event" email has no copy and no defined trigger

PRD §14: `Google Calendar event | Confirmed members | Email + GCal | When an event is created
or updated`.

The GCal half is already done (`lib/google-calendar/sync.ts`, called from
`app/api/events/handler.ts:187`, `app/api/events/[id]/handler.ts`,
`app/api/events/[id]/attendees/handler.ts`). The **email** half cannot be built as specified:

- PRD §30 (the content-template table) has **no row** for a Google Calendar / event email.
  `lib/resend/templates.ts:1-6` is explicitly constrained to "Copy exactly (PRD §30) — do not
  add styling, images, or layout", so adding a `google_calendar_event` template key means
  inventing subject/preview copy that no source material defines.
- The trigger is also undefined in practice: firing on *every* `PATCH /api/events/:id` would
  email every confirmed member on each trivial edit (e.g. a notes typo), and `createEvent`
  normally runs before anyone is an attendee, so a create-time email has no recipients.
- The `google_calendar_event` value exists in `types/domain.ts:34` and the DB enum but is
  never written anywhere.

**Decision needed:** the exact email subject/preview copy, and which event mutations fire it
(create only? update only when start_time/end_time/location change? attendee assignment?).

**Do not guess either of these. Stop and get a human answer.**

---

## Current state (verified, do not re-derive)

Already implemented — **do not touch**:

- `lib/pingram/client.ts` — `sendSms({ to, body, smsOptedIn })` → `{status:"sent"|"skipped"}`;
  enforces `sms_opted_in` itself and returns `{status:"skipped", reason}` for
  `not_opted_in` / `no_phone` / `invalid_phone` with no network call. Throws
  `SmsNotConfiguredError` / `SmsValidationError` / `SmsDispatchError`.
- `lib/resend/client.ts` — `sendEmail(to, template, data)`. Throws when unconfigured or on
  Resend error.
- `lib/notifications/sms-templates.ts` and `lib/resend/templates.ts` — all copy builders.
- **Invitation accepted** (PRD channel: *In-app only*) — already correct.
  `accept_invitation` RPC (`supabase/migrations/20260712000001_accept_invitation_rpc.sql:101-123`)
  inserts the `invitation_accepted` in-app notification to `invited_by`, or to all
  admins/set_leaders when `invited_by` is null. **No SMS/email may be added here** — the PRD
  channel is in-app only. This type requires zero code change; the coder must note that in
  `.pipeline/changes.md` so the tester covers it as a no-regression case.
- **Invitation reminder — member SMS** — already sent from
  `app/api/cron/invitation-reminders/route.ts:41-68`. Only the *admin* SMS is missing (below).

RLS facts that make the plan below work (`supabase/migrations/20260704000001_rls_policies.sql:72`):
`users_select_tenant` lets **any** authenticated user SELECT **every** `users` row in their own
church group, including `name`, `email`, `phone`, `sms_opted_in`. So authenticated handlers can
look up recipient contact details directly. The `anon` (no-session) paths cannot — those need the
data returned from a SECURITY DEFINER RPC (see §3 and §5).

The service-role key stays banned in `app/` and `lib/` (`scripts/check-service-role.mjs`).

---

## 1. New file: `lib/notifications/dispatch.ts`

Pattern to copy: `lib/scheduling/conflict-detection.ts` (server-only lib module wrapping a
side-effecting call, with a doc comment explaining the RLS/consent constraints).

```ts
import "server-only";

export type NotificationRecipient = {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  smsOptedIn: boolean;
};

export type DispatchCounts = {
  smsSent: number;
  smsSkipped: number;
  smsFailed: number;
  emailSent: number;
  emailSkipped: number;
  emailFailed: number;
};

// Absolute app URL for a notification deep link. Mirrors the existing `appUrl`
// helper in app/api/invitations/handler.ts (line ~276): NEXT_PUBLIC_APP_URL with
// trailing slashes stripped, or a site-relative path when it is unset.
export function appNotificationUrl(path: string): string;

export async function dispatchNotification<K extends EmailTemplateKey>(params: {
  recipients: NotificationRecipient[];
  sms?: { body: string };
  email?: { template: K; data: EmailTemplateDataMap[K] };
}): Promise<DispatchCounts>;
```

(`EmailTemplateKey` / `EmailTemplateDataMap` imported from `@/lib/resend/templates`.)

Required behavior:

- **Never throws.** Every call site awaits it and must still return its normal success
  response even when every send fails.
- Dedupe `recipients` by `userId`, first occurrence wins.
- `sms` omitted → the SMS channel is not attempted at all (all sms counters stay 0).
  `email` omitted → likewise.
- Per recipient, SMS: `await sendSms({ to: r.phone, body: params.sms.body, smsOptedIn: r.smsOptedIn })`.
  `status:"sent"` → `smsSent++`; `status:"skipped"` → `smsSkipped++`; a thrown error →
  `smsFailed++` and `console.error`.
- Per recipient, email: `r.email` null/blank → `emailSkipped++` with no call. Otherwise
  `await sendEmail(r.email, params.email.template, params.email.data)` → `emailSent++`; a
  thrown error (including a `renderEmailTemplate` link-validation throw) → `emailFailed++`
  and `console.error`.
- **PII rule (PRD §25.6, already followed in `lib/resend/client.ts:58`):** `console.error` may
  log the recipient's `userId` and the error only — never a phone number, email address,
  message body, or subject.
- Sends are sequential (`for … of` with `await`), matching the existing loop in
  `app/api/cron/invitation-reminders/route.ts`.

---

## 2. Set invitation — SMS + Email to the member

PRD row: `Set invitation | Member | SMS + Email`.

### 2a. `app/api/invitations/handler.ts` → `createInvitation`

Replace the TODO at line 265 (`// TODO(#67/#68): dispatch SMS/email invitation notification here.`).
Insert after `writeAuditLog`, before the `return ok(...)`.

- Look up both parties in one query:
  `supabase.from("users").select("id, name, email, phone, sms_opted_in").in("id", [parsed.userId, ctx.userId])`.
  On error or when the member row is missing → skip dispatch entirely and still return 201.
- `const date = formatWeekLabel(week.title, week.service_date)` — import `formatWeekLabel`
  from `@/lib/scheduling/reminder`. (`week` is already in scope, selected with `select("*")`.)
- `const link = appNotificationUrl(\`/invite/${invitation.response_token}\`)` — matches the
  existing public route `app/(public)/invite/[token]/page.tsx`.
- `await dispatchNotification({ recipients: [member], sms: { body: setInvitationSms({ date, roleNote: invitation.role_note, link }) }, email: { template: "set_invitation", data: { date, adminName: adminRow?.name ?? "Your worship leader", link } } })`.
- The response body is unchanged.

### 2b. `app/api/invitations/handler.ts` → `createGuestInvitation`

Replace the TODO at line 498 (`// TODO(#68): dispatch the guest invitation email with accountSetupUrl.`).

- Hoist `inviteUrl` / `accountSetupUrl` (currently built inline in the `ok(...)` payload at
  lines 506-507) into consts above, and reuse them in the response so the values stay identical.
- `const link = accountSetupUrl ?? inviteUrl` (new users land on account setup, existing users
  on the normal invite page).
- Look up `[guestUserId, ctx.userId]` with the same `users` select as 2a; skip dispatch on
  error / missing row.
- Same `dispatchNotification` call as 2a, with `roleNote: invitation.role_note`. Pass **both**
  `sms` and `email` — a freshly provisioned placeholder guest has `phone: null` and
  `sms_opted_in` default false, so `sendSms` skips it by itself; do not special-case it.
- The response body is unchanged.

---

## 3. Invitation reminder — add the missing **admin** SMS

PRD row: `Invitation reminder | Member + Admin | SMS` (SMS only — **no email**).

### 3a. Migration `supabase/migrations/20260831000001_notification_trigger_dispatch.sql`

One migration file covers §3 and §5. Follow the header-comment + `-- ============ UP ============`
/ commented-`DOWN` shape of `supabase/migrations/20260713000003_invitation_reminder_scheduler.sql`.

`CREATE OR REPLACE FUNCTION public.send_invitation_reminders()` — same body as today, except the
return value changes from a bare jsonb array to a jsonb object:

```
RETURN jsonb_build_object(
  'member_reminders', v_reminders,     -- unchanged shape, still may be []
  'admin_reminders',  v_admin_reminders
);
```

`v_admin_reminders` is accumulated inside the **existing** per-week / per-recipient loop (the
one at lines 106-117 that inserts the admin in-app notification) — one entry per
(service week × admin/set_leader recipient), with the recipient's contact columns:

```
{ 'user_id', 'name', 'phone', 'sms_opted_in',
  'service_week_id', 'service_date', 'week_title', 'pending_count' }
```

`pending_count` is the `v_count` already computed for that week. Do not change the selector,
the `last_reminded_at` stamping, the in-app notification inserts, or the GRANT.

### 3b. `lib/supabase/types.ts`

Change `Functions.send_invitation_reminders.Returns` (lines 544-556) from the array to:

```ts
Returns: {
  member_reminders: Array<{ /* existing 8 fields, unchanged */ }>;
  admin_reminders: Array<{
    user_id: string;
    name: string;
    phone: string | null;
    sms_opted_in: boolean;
    service_week_id: string;
    service_date: string;
    week_title: string | null;
    pending_count: number;
  }>;
};
```

### 3c. `app/api/cron/invitation-reminders/route.ts`

- `const payload = data ?? { member_reminders: [], admin_reminders: [] };` and defensively
  default each array (`payload.member_reminders ?? []`).
- The member loop is unchanged in behavior — keep the existing pre-loop
  `!reminder.phone || reminder.sms_opted_in !== true` guard, `buildMemberReminderSms`,
  `formatWeekLabel`, and the sent/skipped/failed counters exactly as they are.
- Add an admin loop after it. For each `admin_reminders` entry:
  `await dispatchNotification({ recipients: [{ userId: a.user_id, name: a.name, email: null, phone: a.phone, smsOptedIn: a.sms_opted_in }], sms: { body: adminReminderSms({ count: a.pending_count, date: formatWeekLabel(a.week_title, a.service_date), link: appNotificationUrl(\`/week/${a.service_week_id}\`) }) } })`
  — no `email` key (PRD channel is SMS only). Fold the returned
  `smsSent`/`smsSkipped`/`smsFailed` into the same three counters.
- Response body: keep `{ processed, smsSent, smsSkipped, smsFailed }` (`processed` stays
  `member_reminders.length`) and **add** `adminNotified: admin_reminders.length`. Existing
  assertions on the four current fields must keep passing.

---

## 4. Invitation denied — SMS + Email to the admin

PRD row: `Invitation denied | Admin | SMS + Email`. Both deny paths must fire it.

Shared payload for both paths:
- `memberName` = the denying member's `users.name`
- `date` = `formatWeekLabel(week.title, week.service_date)` for the invitation's service week
- `reason` = the recorded `denial_reason` (may be null)
- `link` = `appNotificationUrl(\`/week/${serviceWeekId}\`)`
- `sms.body` = `invitationDeniedSms({ memberName, date, reason, link })`
- `email` = `{ template: "invitation_denied", data: { memberName, date, reason, link } }`

### 4a. Authenticated path — `app/api/invitations/handler.ts` → `denyInvitation`

Replace the TODO at line 744. Insert after `writeAuditLog`, before `return ok(...)`. Uses the
denying member's own RLS client (allowed by `users_select_tenant`). Follow the multi-query
in-memory-join style of `app/api/conflicts/handler.ts` `getOpenConflicts`:

1. member name: `.from("users").select("name").eq("id", inv.user_id).maybeSingle()`
2. week: `.from("service_weeks").select("title, service_date").eq("id", inv.service_week_id).maybeSingle()`
3. recipients (`select("id, name, email, phone, sms_opted_in")`):
   - `inv.invited_by !== null` → `.eq("id", inv.invited_by)`
   - else → `.eq("church_group_id", ctx.churchGroupId).in("role", ["admin", "set_leader"])`
     (mirrors the same fallback in `deny_invitation`, migration lines 105-123)
4. Any query error, or zero recipients → skip dispatch and still return the normal 200.

The early `if (!canTransition(inv.status, "deny")) return ok(...)` idempotency branch (line 694)
must **not** dispatch.

### 4b. No-session token path — needs RPC data

`anon` cannot read `users`, so recipients come from the RPC.

**Migration** (same file as §3a): `CREATE OR REPLACE FUNCTION public.deny_invitation(uuid, text, text)`
— body unchanged except the success return value gains dispatch data:

```
RETURN jsonb_build_object(
  'status', 'denied',
  'already_responded', false,
  'member_name', v_member_name,
  'service_week_id', v_inv.service_week_id,
  'service_date', <service_weeks.service_date for v_inv.service_week_id>,
  'week_title',   <service_weeks.title    for v_inv.service_week_id>,
  'reason', p_reason,
  'recipients', v_recipients
);
```

`v_recipients` is a jsonb array of `{ user_id, name, email, phone, sms_opted_in }` built from the
**same** recipient set the in-app notification loop already uses (`invited_by` if non-null, else
all admins/set_leaders in the group). The already-responded early return (lines 72-77) must add
`'recipients', '[]'::jsonb` so the route can branch uniformly. Remove the now-satisfied
`TODO(#67/#68)` comment at line 134. Keep the GRANT unchanged.

**`lib/supabase/types.ts`**: extend `Functions.deny_invitation.Returns` (lines 521-524) with the
new optional-shaped fields (`member_name: string | null`, `service_week_id: string | null`,
`service_date: string | null`, `week_title: string | null`, `reason: string | null`,
`recipients: Array<{ user_id: string; name: string; email: string | null; phone: string | null; sms_opted_in: boolean }>`).

**Route** (`denyInvitation`, the `responseToken !== undefined` branch, lines 638-665): after the
RPC succeeds and before `return ok(...)`, if `(data.recipients ?? []).length > 0` build the shared
payload from `data` and `await dispatchNotification(...)`. The returned JSON body must stay exactly
`{ invitationId, status, alreadyResponded }` — do not leak recipient data to the caller.

---

## 5. Setlist released — SMS + Email to confirmed members

PRD row: `Setlist released | All confirmed | SMS + Email`.

`app/api/setlists/[id]/handler.ts` → `publishSetlist`. Replace the TODO at line 471, inside the
existing `if (recipientIds.length > 0)` block, after the in-app `notifications` insert.

- Contact rows: `.from("users").select("id, name, email, phone, sms_opted_in").in("id", recipientIds)`.
- Week label: `.from("service_weeks").select("title, service_date").eq("id", updated.service_week_id).maybeSingle()`
  → `formatWeekLabel(...)`.
- `link = appNotificationUrl(\`/week/${updated.service_week_id}\`)`.
- `sms.body = setlistPublishedSms({ date, link })`;
  `email = { template: "setlist_released", data: { date, songCount, link } }`
  (`songCount` is already computed at line 437 and may legitimately be 0 — BR-01).
- On a contact/week query error: skip dispatch, still return 200. The in-app notifications are
  already committed and are the source of truth.

---

## 6. Scheduling conflict — SMS + Email to admins

PRD row: `Scheduling conflict | Admin only | SMS + Email`.

No migration needed: the trigger path runs as an authenticated member, and `users_select_tenant`
lets them read the admins' contact rows.

### 6a. `lib/scheduling/conflict-detection.ts` — add a second export

```ts
export async function dispatchConflictNotifications(
  supabase: SupabaseClient<Database>,
  actor: { userId: string; churchGroupId: string },
  date: string, // YYYY-MM-DD, the availability date
): Promise<void>;
```

Best-effort, **never throws** (unlike `recordAvailabilityConflict`, which throws on DB error —
keep that one as is). Behavior:

- member name: `.from("users").select("name").eq("id", actor.userId).maybeSingle()`
- recipients: `.from("users").select("id, name, email, phone, sms_opted_in").eq("church_group_id", actor.churchGroupId).in("role", ["admin", "set_leader"]).neq("id", actor.userId)`
  — the `.neq` mirrors the RPC's "excluding the triggering member" rule
  (`supabase/migrations/20260713000001_conflict_notification.sql:99-106`).
- `const label = formatWeekLabel(null, date)` (import from `@/lib/scheduling/reminder`).
- `link = appNotificationUrl("/conflicts")` (route `app/(app)/conflicts/page.tsx`).
- `sms.body = schedulingConflictSms({ memberName, date: label, link })`;
  `email = { template: "scheduling_conflict", data: { memberName, date: label, link } }`.
- Zero recipients or any query error → return silently.

### 6b. `app/api/availability/handler.ts` — two call sites

- `setAvailability` (loop at lines 163-168): when `recordAvailabilityConflict(...)` returns
  `true` for a date, `await dispatchConflictNotifications(supabase, ctx, date)` for that date.
- `deleteAvailability` (line 234): when `conflictTriggered` is `true`,
  `await dispatchConflictNotifications(supabase, ctx, parsedDate.data)`.

Response bodies are unchanged in both.

---

## 7. Comment-only cleanup (bounded — no behavior change)

`tests/e2e/invitation-deny.spec.ts` lines 12-20 and 68-74 assert in prose that the deny handler
"only has a TODO" and that the dispatch primitives are "unimplemented throwing stubs". That is
now false. Update the two comment blocks (and the `test.skip` title string on line 72) to state
that admin SMS+email dispatch **is** wired as of #69 but that asserting real delivery stays out
of scope for this issue (#82 owns full E2E regression). **Do not un-skip the test, do not change
any test logic, and do not touch any other e2e or load-test file.**

---

## Edge cases the implementation must handle

1. `sms_opted_in === false` → `sendSms` returns `{status:"skipped", reason:"not_opted_in"}`; no
   Pingram HTTP call is made. Counted as `smsSkipped`. **This is the AC's "opted-out members
   excluded" case.**
2. `phone` null/blank, or a phone that `toE164` cannot normalize → `smsSkipped`, no HTTP call.
3. `email` null or whitespace-only → `emailSkipped`, `sendEmail` is not called; the SMS channel
   still runs for that recipient.
4. Zero recipients (e.g. publish with no accepted invitations, deny with `invited_by` null and no
   admins) → no send calls, no throw, normal success response.
5. Duplicate `userId` in `recipients` → exactly one SMS and one email.
6. `sendSms` throws (`SmsNotConfiguredError`, `SmsDispatchError`, `SmsValidationError`) →
   `smsFailed`, logged, request still returns its normal 2xx.
7. `sendEmail` throws (Resend unconfigured, Resend API error) → `emailFailed`, request still 2xx.
8. `NEXT_PUBLIC_APP_URL` unset → `appNotificationUrl` returns a site-relative path;
   `renderEmailTemplate` rejects it (`Email template link must be an absolute HTTPS URL`,
   `lib/resend/templates.ts:60-73`). `dispatchNotification` must catch this as `emailFailed` —
   **it must not 500 the request**, and the SMS must still go out (SMS templates accept a
   relative link without throwing).
9. Deny/accept idempotency: an already-responded invitation dispatches nothing on either the
   authenticated or the token path.
10. `denial_reason` null → `invitationDeniedSms` and the `invitation_denied` email both omit the
    reason clause; do not substitute `"null"` or an empty `Reason:` label.
11. Publish with `songCount === 0` still dispatches (BR-01 permits publishing an empty setlist).
12. Guest invitation, existing-user branch (`isNewUser === false`) → link is `inviteUrl`;
    new-user branch → `accountSetupUrl`.
13. A conflict triggered by a member who is themselves an admin/set_leader → they do not notify
    themselves.
14. Cross-group `userId` in `createInvitation` → the `users` lookup returns nothing under RLS →
    skip dispatch, still return 201 (do not throw on the missing row).
15. `console.error` on any dispatch failure logs `userId` + error only, never phone/email/body.

---

## Tests the coder must write (`bun run test`)

Follow `tests/unit/app/api/setlists-publish-route.test.ts` (stateful in-memory fake Supabase
client + `jest.mock("@clerk/nextjs/server")` + `jest.mock("@/lib/supabase/client")`) and
`tests/unit/app/api/cron-invitation-reminders-route-issue67-supplement.test.ts`
(`jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }))`).

New files — do not overwrite any existing test file:

- `tests/unit/lib/notifications/dispatch.test.ts` — edge cases 1-8 and 15 against
  `dispatchNotification` / `appNotificationUrl` directly, with `sendSms` and `sendEmail` mocked.
- `tests/unit/app/api/invitations-route-notifications.test.ts` — §2a and §2b; asserts the
  template key, the rendered link, and edge cases 12 and 14.
- `tests/unit/app/api/invitations-deny-route-notifications.test.ts` — §4a and §4b (both branches),
  plus edge cases 9 and 10 and the `invited_by === null` fan-out.
- `tests/unit/app/api/setlists-publish-notifications.test.ts` — §5, plus edge cases 4 and 11.
- `tests/unit/app/api/availability-conflict-notifications.test.ts` — §6, plus edge case 13.
- `tests/unit/app/api/cron-invitation-reminders-admin-sms.test.ts` — §3c: admin SMS fires with
  `pending_count`, uses SMS only (assert `sendEmail` is never called), counters aggregate across
  both loops, and the member loop's existing behavior is unchanged.

Every route-level test must additionally assert that a total dispatch failure still yields the
handler's normal success status code.

Verify with `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:service-role`.

---

## Out of scope — do not touch

- In-app inbox UI / routes (`app/(app)/notifications/`, `app/api/notifications/*`) — #71/#73.
- `notification_preferences` enforcement (channel-per-type gating, `reminder_hours_before`) —
  #70. The only opt-out honored here is `users.sms_opted_in`, which `sendSms` already enforces.
- `schemas/notifications.ts`'s `notificationsSchema` TODO.
- Adding SMS or email to **Invitation accepted** (PRD: in-app only).
- Chat mention, devotion shared, new church document, transcription complete (Phase 2+).
- Any e2e (`tests/e2e/`) or load (`tests/load/`) file other than the bounded comment edit in §7.
- The Pingram/Resend delivery-status webhooks — already shipped by #67/#68.
