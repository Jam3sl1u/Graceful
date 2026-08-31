-- Migration: notification trigger dispatch data — Issue #69
--
-- Issue #69 wires the real SMS + Email fan-out for every Phase 1 notification
-- type. Two of those paths run without a Clerk session and cannot read the
-- `users` table under RLS to resolve recipient contact details:
--
--   1. GET /api/cron/invitation-reminders — the hourly cron job (anon role)
--      already gets the *member* reminders it must SMS from
--      send_invitation_reminders(); it now also needs the *admin* reminders
--      (PRD §14: "Invitation reminder | Member + Admin | SMS").
--   2. POST /api/invitations/:id/deny (no-session token path) — deny_invitation()
--      must return the admin recipient contact rows so the route can SMS + Email
--      them (PRD §14: "Invitation denied | Admin | SMS + Email").
--
-- Both functions are CREATE OR REPLACE only: no new tables, columns, grants, or
-- selectors — just a richer return payload. Follows the per-migration
-- convention of 20260713000003_invitation_reminder_scheduler.sql.

-- ============ UP ============

-- send_invitation_reminders(): unchanged behavior (same selector, same
-- last_reminded_at stamping, same in-app notification inserts). The return
-- value changes from a bare jsonb array of member reminders to a jsonb object
-- with two arrays: `member_reminders` (unchanged shape) and `admin_reminders`
-- (one entry per service week × admin/set_leader recipient, carrying that
-- recipient's contact columns and the week's pending count).
CREATE OR REPLACE FUNCTION public.send_invitation_reminders()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_reminders        jsonb;
  v_admin_reminders  jsonb := '[]'::jsonb;
  v_week             record;
  v_member_list      text;
  v_count            int;
  v_recipient        record;
  v_week_label       text;
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
      SELECT id, name, phone, sms_opted_in FROM public.users
      WHERE church_group_id = v_week.church_group_id
        AND role IN ('admin', 'set_leader')
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_week.church_group_id, v_recipient.id, 'invitation_reminder', 'Unanswered invitations',
         v_count || ' invitation(s) still unanswered for ' || v_week_label || ': ' || v_member_list,
         'service_week', v_week.id);

      v_admin_reminders := v_admin_reminders || jsonb_build_object(
        'user_id', v_recipient.id,
        'name', v_recipient.name,
        'phone', v_recipient.phone,
        'sms_opted_in', v_recipient.sms_opted_in,
        'service_week_id', v_week.id,
        'service_date', v_week.service_date,
        'week_title', v_week.title,
        'pending_count', v_count
      );
    END LOOP;
  END LOOP;

  -- Stamp only the due invitations.
  UPDATE public.invitations
  SET last_reminded_at = now()
  WHERE id IN (SELECT id FROM due_invitations);

  RETURN jsonb_build_object(
    'member_reminders', v_reminders,
    'admin_reminders',  v_admin_reminders
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_invitation_reminders() TO anon, authenticated;

-- deny_invitation(): unchanged behavior (same authorization, same status flip,
-- same denial_count, same in-app notification recipient set, same audit row).
-- The success return value gains the data the no-session route needs to SMS +
-- Email the admin recipients; the already-responded early return gains an empty
-- `recipients` array so the route can branch uniformly.
CREATE OR REPLACE FUNCTION public.deny_invitation(
  p_invitation_id   uuid,
  p_response_token  text,
  p_reason          text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_inv           public.invitations%ROWTYPE;
  v_clerk_id      text;
  v_caller_id     uuid;
  v_denial_count  int;
  v_member_name   text;
  v_recipient     record;
  v_recipients    jsonb := '[]'::jsonb;
  v_service_date  date;
  v_week_title    text;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE id = p_invitation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Authorize.
  IF p_response_token IS NOT NULL THEN
    IF p_response_token <> v_inv.response_token THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    v_clerk_id := auth.jwt() ->> 'sub';
    IF v_clerk_id IS NULL THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_caller_id FROM public.users WHERE clerk_id = v_clerk_id;
    IF v_caller_id IS NULL OR v_caller_id <> v_inv.user_id THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Already responded (graceful, not an error): covers accepted/denied/withdrawn.
  IF v_inv.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'status', v_inv.status,
      'already_responded', true,
      'recipients', '[]'::jsonb
    );
  END IF;

  -- Expiry (checked after the already-responded check, so a previously
  -- denied-but-now-past invite still returns 200 denied above).
  IF v_inv.response_deadline IS NOT NULL AND now() > v_inv.response_deadline THEN
    RAISE EXCEPTION 'EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  -- BR-08 denial_count is per member+week, counted across invitation rows
  -- (mirrors the authenticated path, handler.ts denyInvitation).
  SELECT count(*) INTO v_denial_count
  FROM public.invitations
  WHERE user_id = v_inv.user_id
    AND service_week_id = v_inv.service_week_id
    AND status = 'denied';
  v_denial_count := v_denial_count + 1;

  UPDATE public.invitations
  SET status = 'denied',
      denial_reason = p_reason,
      denial_count = v_denial_count,
      responded_at = now()
  WHERE id = p_invitation_id;

  -- Notify admin in-app: the inviting user if known, else every admin/
  -- set_leader in the group.
  SELECT name INTO v_member_name FROM public.users WHERE id = v_inv.user_id;
  SELECT service_date, title INTO v_service_date, v_week_title
  FROM public.service_weeks WHERE id = v_inv.service_week_id;

  IF v_inv.invited_by IS NOT NULL THEN
    INSERT INTO public.notifications
      (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
    VALUES
      (v_inv.church_group_id, v_inv.invited_by, 'invitation_denied', 'Invitation declined',
       v_member_name || ' declined their set invitation', 'invitation', v_inv.id);

    SELECT jsonb_agg(jsonb_build_object(
             'user_id', u.id,
             'name', u.name,
             'email', u.email,
             'phone', u.phone,
             'sms_opted_in', u.sms_opted_in))
    INTO v_recipients
    FROM public.users u
    WHERE u.id = v_inv.invited_by;
  ELSE
    FOR v_recipient IN
      SELECT id, name, email, phone, sms_opted_in FROM public.users
      WHERE church_group_id = v_inv.church_group_id
        AND role IN ('admin', 'set_leader')
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_inv.church_group_id, v_recipient.id, 'invitation_denied', 'Invitation declined',
         v_member_name || ' declined their set invitation', 'invitation', v_inv.id);

      v_recipients := v_recipients || jsonb_build_object(
        'user_id', v_recipient.id,
        'name', v_recipient.name,
        'email', v_recipient.email,
        'phone', v_recipient.phone,
        'sms_opted_in', v_recipient.sms_opted_in
      );
    END LOOP;
  END IF;

  -- Audit log (insert directly — this is the no-session-safe equivalent of
  -- write_audit_log, which cannot be used here because it derives identity
  -- from the JWT).
  INSERT INTO public.audit_logs (church_group_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (v_inv.church_group_id, v_inv.user_id, 'invitation.denied', 'invitation', v_inv.id,
    jsonb_build_object(
      'denial_count', v_denial_count,
      'reason_provided', p_reason IS NOT NULL));

  RETURN jsonb_build_object(
    'status', 'denied',
    'already_responded', false,
    'member_name', v_member_name,
    'service_week_id', v_inv.service_week_id,
    'service_date', v_service_date,
    'week_title', v_week_title,
    'reason', p_reason,
    'recipients', coalesce(v_recipients, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.deny_invitation(uuid, text, text) TO anon, authenticated;

-- ============ DOWN ============
-- Restore the prior definitions from
-- 20260713000003_invitation_reminder_scheduler.sql (send_invitation_reminders)
-- and 20260713000002_deny_invitation_rpc.sql (deny_invitation).
