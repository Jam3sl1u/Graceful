# Spec — Issue #45: 24-hour dual-party invitation reminder scheduler

A scheduled job that, every time it runs, finds every `pending` invitation whose
last reminder (or creation, if never reminded) is 24h+ in the past and, for each:
fires an **SMS to the member** (via the existing `sendSms` stub) and inserts an
**in-app notification to every admin/set_leader** in the group listing all
still-pending invitations for that service week by member name. The reminder
re-fires every 24h until the invitation leaves `pending` (member accepts/denies,
admin withdraws), at which point it is simply no longer selected — cancellation
is automatic, driven entirely by `status = 'pending'`, so there is nothing to
"cancel" explicitly.

## No blocking OPEN QUESTIONS

The acceptance criteria and existing repo patterns fully determine the design.
Two design decisions the coder must simply follow (not re-litigate):

- **D1 — Automatic cancellation.** AC "cancel all future reminders on response or
  withdrawal" is satisfied structurally: the selector filters `status = 'pending'`,
  so once the RPC in #41 (accept), `denyInvitation`, or `withdrawInvitation`
  flips the status, the invitation is never selected again. Do NOT add a
  cancellation table, job de-registration, or per-invitation scheduler state.
- **D2 — Admin notification granularity.** AC says the admin reminder lists "all
  pending invitations for the week by name." Aggregate **per service week**: when
  a week has one or more *due* invitations, insert exactly one notification per
  admin/set_leader recipient whose body lists **all** currently-pending members
  for that week (including any pending-but-not-yet-due ones). Do not insert one
  admin notification per invitation.

Two things to be aware of but which are NOT blockers (follow the AC literally):

- **N1 — Anon-callable RPC exposure.** The job has no Clerk session, and the
  Supabase service-role key is banned in `app/` and `lib/`
  (`scripts/check-service-role.mjs`), so the DB work runs through a
  `SECURITY DEFINER` RPC granted to `anon`, invoked via `getAnonSupabaseClient()`
  — exactly the `accept_invitation` pattern. The RPC computes its 24h threshold
  internally and stamps `last_reminded_at`, so it is self-throttling: a stray
  anon call can at worst advance each invitation's reminder by at most one 24h
  cycle. The HTTP endpoint is additionally guarded by `CRON_SECRET`. This is an
  accepted Phase-1 trade-off; do not invent extra DB-side secret handling.
- **N2 — Expired invitations.** An invitation past its 72h `response_deadline`
  can no longer be accepted (the `accept_invitation` RPC raises `EXPIRED`), yet
  AC N says "repeats every 24 hours **until response or withdrawal**." Follow the
  AC literally: keep reminding while `status = 'pending'`, regardless of
  `response_deadline`. Do not add a deadline cutoff.

## Reference files (copy these patterns)

- **RPC to copy from:** `supabase/migrations/20260712000001_accept_invitation_rpc.sql`
  — same header-comment style, `SECURITY DEFINER`, `SET search_path = ''`,
  `%ROWTYPE` locals, notification `INSERT` shape, `GRANT EXECUTE ... TO anon,
  authenticated`, and commented `-- ============ DOWN` block.
- **Enum-add migration to copy from:** `supabase/migrations/20260712000002_invitation_withdrawn_notification_type.sql`
  (NOTE: the `invitation_reminder` enum value ALREADY EXISTS in
  `20260702000005_cluster_5_partial.sql` — do NOT add it again).
- **Anon-RPC handler pattern:** `getInvitationByToken` / the `responseToken`
  branch of `acceptInvitation` in `app/api/invitations/handler.ts`
  (`getAnonSupabaseClient()` + `supabase.rpc(...)` + error-message → HTTP map).
- **Pure-helper + RPC-call test pattern:** `lib/scheduling/conflict-detection.ts`
  and `tests/unit/lib/scheduling/conflict-detection.test.ts`.
- **Route-with-mocked-supabase test pattern:**
  `tests/unit/app/api/invitations-withdraw-route.test.ts` (the `makeChain` /
  `makeSupabaseClient` / `rpc` hook scaffolding).
- **Simple route shape:** `app/api/health/route.ts`.

## Files to create / modify

### 1. `supabase/migrations/20260713000001_invitation_reminder_scheduler.sql` (CREATE)

Two things in one migration, in this order:

**(a) Add the `last_reminded_at` column + supporting index** (invitations table is
defined in `20260702000003_cluster_3_scheduling_core.sql`, which has no such
column):

```sql
ALTER TABLE public.invitations
  ADD COLUMN last_reminded_at timestamptz;

-- Speeds the reminder selector: only pending rows are ever scanned.
CREATE INDEX idx_invitations_pending_reminder
  ON public.invitations (last_reminded_at, created_at)
  WHERE status = 'pending';
```

**(b) The `send_invitation_reminders()` SECURITY DEFINER RPC.** Structure it like
`accept_invitation`: header comment explaining why it must be SECURITY DEFINER
(no session + service-role ban + must INSERT notifications a plain member cannot),
`SET search_path = ''`, `VOLATILE`, all `public.`-qualified. Signature and
contract:

```sql
CREATE OR REPLACE FUNCTION public.send_invitation_reminders()
  RETURNS jsonb        -- JSON array of member SMS reminders to dispatch
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
```

Behavior, in one transaction:

1. **Select due invitations** into a temp set / CTE:
   `status = 'pending'` AND `coalesce(last_reminded_at, created_at) <= now() - interval '24 hours'`
   AND the parent `service_weeks.is_cancelled = false` (join `service_weeks`).
   (The `coalesce` handles both first reminder — `last_reminded_at IS NULL` uses
   `created_at` — and repeats.)
2. **Build the member reminder array** (the RETURN value): for each due
   invitation join `users` (member) and `service_weeks`. Emit one object:
   ```json
   { "invitation_id": "...", "user_id": "...", "member_name": "...",
     "phone": null, "sms_opted_in": true,
     "service_week_id": "...", "service_date": "2026-08-01", "week_title": null }
   ```
   Coalesce the whole array to `'[]'::jsonb` when empty.
3. **Insert admin notifications, aggregated per affected week** (D2): for each
   DISTINCT `service_week_id` among the due invitations, gather all currently
   `pending` members for that week (name list, ordered by name), then for every
   `users` row in that `church_group_id` with `role IN ('admin','set_leader')`
   INSERT one notification:
   - `type = 'invitation_reminder'`
   - `title = 'Unanswered invitations'`
   - `body`  = a human sentence naming the week and listing the members, e.g.
     `'2 invitation(s) still unanswered for ' || <week label> || ': ' || <comma-joined names>`
     where `<week label>` is `coalesce(week.title, to_char(week.service_date,'Mon DD, YYYY'))`.
   - `link_entity_type = 'service_week'`, `link_entity_id = <week id>`.
4. **Stamp** `last_reminded_at = now()` on every due invitation (only the due
   ones — not other pending rows in the same week).
5. `RETURN` the member reminder array from step 2.

Grant + DOWN:
```sql
GRANT EXECUTE ON FUNCTION public.send_invitation_reminders() TO anon, authenticated;
-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.send_invitation_reminders();
-- DROP INDEX IF EXISTS idx_invitations_pending_reminder;
-- ALTER TABLE public.invitations DROP COLUMN IF EXISTS last_reminded_at;
```

### 2. `lib/supabase/types.ts` (MODIFY)

- Add `last_reminded_at: string | null;` to `InvitationsRow` (line ~102-116).
- In the `invitations` table `Insert` (line ~218), add `last_reminded_at` to the
  `Omit<...>` union and add `last_reminded_at?: string | null;` to the override
  block (DB-defaulted to NULL, so it must be optional on insert). `Update:
  Partial<InvitationsRow>` already covers the stamp.
- Add to `Database["public"]["Functions"]` (next to `accept_invitation`):
  ```ts
  send_invitation_reminders: {
    Args: Record<string, never>;
    Returns: Array<{
      invitation_id: string;
      user_id: string;
      member_name: string;
      phone: string | null;
      sms_opted_in: boolean;
      service_week_id: string;
      service_date: string;
      week_title: string | null;
    }>;
  };
  ```

### 3. `lib/scheduling/reminder.ts` (CREATE — pure, unit-testable logic)

The mocked-time-testable "reminder logic" the AC requires lives here (the SQL
selector in the RPC mirrors `isReminderDue` and must stay in sync with it — call
that out in a comment). No `server-only` import needed if it stays pure; match
`lib/scheduling/conflict-detection.ts` conventions otherwise.

```ts
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Mirrors the SQL selector in send_invitation_reminders():
//   status === 'pending' && coalesce(lastRemindedAt, createdAt) <= now - 24h
export function isReminderDue(
  invitation: { status: string; createdAt: string; lastRemindedAt: string | null },
  now: Date,
): boolean;

// Member SMS copy. Keep it short (SMS). weekLabel is the title or a formatted date.
export function buildMemberReminderSms(memberName: string, weekLabel: string): string;

// Week label used in both the SMS and (conceptually) the admin body.
export function formatWeekLabel(title: string | null, serviceDate: string): string;
```

`isReminderDue`: parse `lastRemindedAt ?? createdAt` to ms; return
`status === "pending" && anchorMs <= now.getTime() - REMINDER_INTERVAL_MS`.

### 4. `app/api/cron/invitation-reminders/route.ts` (CREATE)

Vercel Cron issues a **GET**. Export `GET` only.

```ts
import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { sendSms } from "@/lib/pingram/client";
import { buildMemberReminderSms, formatWeekLabel } from "@/lib/scheduling/reminder";

export async function GET(req: NextRequest): Promise<Response> { ... }
```

Contract:
1. **Auth.** Read `process.env.CRON_SECRET`. If unset → `fail("Internal error",
   ErrorCode.INTERNAL, 500)` (misconfiguration). If the `Authorization` header is
   not exactly `Bearer ${CRON_SECRET}` → `fail("Authentication required",
   ErrorCode.UNAUTHENTICATED, 401)`. Do this before any DB work.
2. `const supabase = getAnonSupabaseClient();`
3. `const { data, error } = await supabase.rpc("send_invitation_reminders");`
   On `error` → `fail("Internal error", ErrorCode.INTERNAL, 500)`.
4. For each reminder in `data` (array): if `phone` is non-null AND
   `sms_opted_in === true`, call
   `sendSms(phone, buildMemberReminderSms(member_name, formatWeekLabel(week_title, service_date)))`
   inside a `try/catch`. **Swallow the error** (increment a `smsFailed` counter,
   optionally `console.error`) — `sendSms` currently throws
   `"sendSms not implemented — see Sprint 4 #58"` (`lib/pingram/client.ts`), and a
   stubbed dispatch MUST NOT fail the whole job (Implementation Notes: "stub the
   send call"). Members with no phone / `sms_opted_in === false` are skipped for
   SMS but are still counted as processed (they were stamped + listed to admins).
5. Return `ok({ processed: data.length, smsSent, smsSkipped, smsFailed })`.

### 5. `vercel.json` (CREATE — does not exist in the repo)

Register the cron. Run it hourly so an invitation is reminded within ~1h of
crossing each 24h mark (the RPC's `last_reminded_at` stamp prevents duplicate
reminders inside a 24h window):

```json
{
  "crons": [
    { "path": "/api/cron/invitation-reminders", "schedule": "0 * * * *" }
  ]
}
```

### 6. `app/api/invitations/handler.ts` (MODIFY — comment only)

`withdrawInvitation` ends with `// TODO(#45/#36): cancel any pending 24h reminders
for this invitation.` (line ~380). Replace it with a comment noting cancellation
is automatic — reminders select on `status = 'pending'`, so the withdraw above
already stops them; nothing to do here. Do NOT change any logic in this file.

### 7. `tests/unit/lib/scheduling/reminder.test.ts` (CREATE — the AC's mocked-time unit test)

Use fixed `Date` fixtures (no real waiting). Cover `isReminderDue`:
- pending, `lastRemindedAt = null`, `createdAt` exactly 24h before `now` → **true**.
- pending, `createdAt` 23h59m before `now` → **false** (just under threshold).
- pending, `createdAt` 25h before `now` → **true**.
- pending, `lastRemindedAt` 2h before `now` (created days ago) → **false**.
- pending, `lastRemindedAt` 24h+ before `now` → **true** (repeat).
- non-pending (`accepted` / `denied` / `withdrawn`) with an ancient `createdAt`
  → **false** (automatic cancellation, D1).
And `buildMemberReminderSms` / `formatWeekLabel`: title present → uses title;
title null → uses formatted `serviceDate`; SMS contains the member name.

### 8. `tests/unit/app/api/cron-invitation-reminders-route.test.ts` (CREATE)

Mirror the mock scaffolding of `invitations-withdraw-route.test.ts`, but mock
`@/lib/supabase/client` (`getAnonSupabaseClient`) and `@/lib/pingram/client`
(`sendSms`). Set `process.env.CRON_SECRET` in the test. Cover:
- **401** when `Authorization` header is missing/wrong (RPC never called).
- **500** when `CRON_SECRET` is unset.
- **500** when the RPC returns an `error`.
- **Happy path:** RPC returns 2 reminders (one with `phone`+`sms_opted_in:true`,
  one with `phone:null`) → 200; `sendSms` called once with the built body; body
  reports `processed: 2`, `smsSent: 1`, `smsSkipped: 1`.
- **SMS failure isolated:** `sendSms` rejects (mimicking the not-implemented
  stub) → still 200, `smsFailed: 1`, job does not throw.

## Edge cases the implementation MUST handle

1. First reminder: `last_reminded_at IS NULL`, `created_at` 24h+ old → due.
2. Repeat: `last_reminded_at` 24h+ old → due again; `< 24h` → not due.
3. Not-yet-aged: pending but `created_at < 24h` old → not selected.
4. Non-pending (accepted/denied/withdrawn) → never selected (D1 cancellation).
5. Cancelled service week (`is_cancelled = true`) → excluded from reminders.
6. Member with no `phone` or `sms_opted_in = false` → SMS skipped, but the row is
   still stamped and the member still appears in the admin listing.
7. Multiple due invitations in the same week → exactly ONE admin notification per
   admin/set_leader recipient, listing all pending members for that week (D2).
8. Multiple admins/set_leaders in a group → each receives the notification.
9. `sendSms` throws (stub / real failure) → caught per-reminder; job returns 200.
10. No due invitations → RPC returns `[]`; route returns 200 with `processed: 0`;
    no SMS, no notifications inserted.
11. Bad/absent `CRON_SECRET` bearer → 401 before any DB call.

## Explicitly OUT OF SCOPE (do not implement)

- Real SMS/email dispatch — call the `sendSms` stub only (#67/#68 own the wiring).
- Configurable per-week response deadlines (issue marks this Phase 2).
- Any cancellation table / scheduler-state store (D1: cancellation is automatic).
- Widening `Database["public"]["Tables"]` beyond the `invitations` changes in §2.
- Changing accept/deny/withdraw logic (only the comment in §6 changes).

## Verification before finishing (Coding stage)

Run `bun run lint`, `bun run typecheck`, `bun run test` (Jest), and
`bun run check:service-role` (the new cron route/RPC caller must not reference the
service-role key). The RPC body itself has no live-DB harness in this repo (like
`accept_invitation`); its correctness is verified by review plus the route/helper
unit tests that mock the RPC return value — do not add a live-DB test.
