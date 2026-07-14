-- Migration: 24-hour dual-party invitation reminder scheduler — Issue #45
--
-- A scheduled job (app/api/cron/invitation-reminders/route.ts, hourly via
-- Vercel Cron) must, on every run, find every `pending` invitation whose
-- last reminder (or creation, if never reminded) is 24h+ in the past, fire
-- an SMS to the member (stub), and insert an in-app notification to every
-- admin/set_leader in the group listing all still-pending invitations for
-- that service week by member name. Like accept_invitation
-- (20260712000001_accept_invitation_rpc.sql), the job has no Clerk session
-- and the service-role key is banned in app/ and lib/
-- (scripts/check-service-role.mjs), so the DB work — including the
-- notifications INSERT a plain member cannot perform under RLS
-- (20260704000001_rls_policies.sql: notifications_insert_leader_admin is
-- leader/admin only) — runs through a SECURITY DEFINER RPC granted to
-- `anon`. The RPC computes its own 24h threshold and stamps
-- last_reminded_at, so it is self-throttling: a stray anon call can at most
-- advance each invitation's reminder by one 24h cycle. The HTTP endpoint is
-- additionally guarded by CRON_SECRET.
--
-- Cancellation of reminders on response/withdrawal is automatic: the
-- selector below filters status = 'pending', so once accept_invitation,
-- denyInvitation, or withdrawInvitation flips the status, the invitation is
-- simply never selected again — no cancellation table or job
-- de-registration is needed.

-- ============ UP ============

ALTER TABLE public.invitations
  ADD COLUMN last_reminded_at timestamptz;

-- Speeds the reminder selector: only pending rows are ever scanned.
CREATE INDEX idx_invitations_pending_reminder
  ON public.invitations (last_reminded_at, created_at)
  WHERE status = 'pending';

-- public.send_invitation_reminders(): finds every pending invitation whose
-- last reminder (or creation, if never reminded) is 24h+ in the past,
-- excluding cancelled service weeks. For each due invitation: stamps
-- last_reminded_at = now() and includes it in the returned member-SMS
-- array. Admin notifications are aggregated per affected service week (not
-- per invitation): for every DISTINCT week among the due invitations, every
-- admin/set_leader in the group gets exactly one notification listing ALL
-- currently-pending members for that week (including pending-but-not-yet-
-- due ones), by name. Returns the JSON array of member reminders the caller
-- must dispatch SMS for; the route handler stubs the actual send via
-- sendSms (lib/pingram/client.ts).
--
-- The selector here mirrors lib/scheduling/reminder.ts's isReminderDue —
-- keep the two in sync if the 24h threshold or pending check ever changes.
CREATE OR REPLACE FUNCTION public.send_invitation_reminders()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_reminders   jsonb;
  v_week        record;
  v_member_list text;
  v_count       int;
  v_recipient   record;
  v_week_label  text;
BEGIN
  -- Due invitations: pending, aged 24h+ since last reminder (or creation),
  -- and the parent service week is not cancelled.
  CREATE TEMPORARY TABLE due_invitations ON COMMIT DROP AS
  SELECT i.id, i.user_id, i.service_week_id
  FROM public.invitations i
  JOIN public.service_weeks sw ON sw.id = i.service_week_id
  WHERE i.status = 'pending'
    AND sw.is_cancelled = false
    AND coalesce(i.last_reminded_at, i.created_at) <= now() - interval '24 hours';

  -- Build the member reminder array.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'invitation_id', di.id,
           'user_id', di.user_id,
           'member_name', u.name,
           'phone', u.phone,
           'sms_opted_in', u.sms_opted_in,
           'service_week_id', sw.id,
           'service_date', sw.service_date,
           'week_title', sw.title
         )), '[]'::jsonb)
  INTO v_reminders
  FROM due_invitations di
  JOIN public.users u ON u.id = di.user_id
  JOIN public.service_weeks sw ON sw.id = di.service_week_id;

  -- Admin notifications, aggregated per affected service week (D2).
  FOR v_week IN
    SELECT DISTINCT sw.id, sw.title, sw.service_date, sw.church_group_id
    FROM due_invitations di
    JOIN public.service_weeks sw ON sw.id = di.service_week_id
  LOOP
    SELECT string_agg(u.name, ', ' ORDER BY u.name), count(*)
    INTO v_member_list, v_count
    FROM public.invitations i
    JOIN public.users u ON u.id = i.user_id
    WHERE i.service_week_id = v_week.id
      AND i.status = 'pending';

    v_week_label := coalesce(v_week.title, to_char(v_week.service_date, 'Mon DD, YYYY'));

    FOR v_recipient IN
      SELECT id FROM public.users
      WHERE church_group_id = v_week.church_group_id
        AND role IN ('admin', 'set_leader')
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_week.church_group_id, v_recipient.id, 'invitation_reminder', 'Unanswered invitations',
         v_count || ' invitation(s) still unanswered for ' || v_week_label || ': ' || v_member_list,
         'service_week', v_week.id);
    END LOOP;
  END LOOP;

  -- Stamp only the due invitations.
  UPDATE public.invitations
  SET last_reminded_at = now()
  WHERE id IN (SELECT id FROM due_invitations);

  RETURN v_reminders;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_invitation_reminders() TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.send_invitation_reminders();
-- DROP INDEX IF EXISTS idx_invitations_pending_reminder;
-- ALTER TABLE public.invitations DROP COLUMN IF EXISTS last_reminded_at;
