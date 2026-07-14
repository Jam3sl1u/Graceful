-- Migration: conflict notification — Issue #46 (BR-15)
--
-- record_availability_conflict (20260711000001_availability_conflict_rpc.sql)
-- already records a conflicts row for every accepted invitation a member
-- loses availability for, but sends no notification — a Set Leader has no
-- way to learn about the conflict short of noticing it in the UI. Extend
-- the RPC (CREATE OR REPLACE, same file-per-migration convention as
-- 20260711000002_service_week_notification_types.sql and
-- 20260712000003_invitation_withdrawn_notification_type.sql; the original
-- 20260711000001_availability_conflict_rpc.sql is left untouched) to also
-- insert an in-app notification per conflict, for every admin/set_leader in
-- the church group (excluding the triggering member).
--
-- Notifications must be inserted from this SECURITY DEFINER RPC rather than
-- from the route handler because notifications_insert_leader_admin
-- (20260704000001_rls_policies.sql) is leader/admin-only — a plain member
-- marking their own availability unavailable cannot insert notifications
-- for other users under plain RLS. Same reason the conflicts insert itself
-- already lives here.
--
-- SMS/email dispatch is deferred to Sprint 4 (#58/#59); this migration only
-- adds the in-app notification, matching every other shipped notify path in
-- this repo (see app/api/invitations/handler.ts createInvitation/
-- denyInvitation, and accept_invitation in
-- 20260712000001_accept_invitation_rpc.sql).

-- ============ UP ============

-- public.record_availability_conflict(p_date, p_trigger_reason): for the
-- caller's own user + church group (derived from JWT), finds every accepted
-- invitation to a service on p_date and records a conflicts row for each,
-- plus an in-app notification to every admin/set_leader in the group
-- (excluding the triggering member). Returns true iff at least one conflict
-- was recorded. p_trigger_reason is caller-supplied free text (e.g.
-- "availability_deleted", "marked_unavailable") stored on
-- conflicts.trigger_reason for auditability.
CREATE OR REPLACE FUNCTION public.record_availability_conflict(
  p_date           date,
  p_trigger_reason text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id     text;
  v_user_id      uuid;
  v_group_id     uuid;
  v_invitation   record;
  v_triggered    boolean := false;
  v_conflict_id  uuid;
  v_member_name  text;
  v_reason       text;
  v_service_label text;
  v_recipient    record;
BEGIN
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, church_group_id INTO v_user_id, v_group_id
  FROM public.users WHERE clerk_id = v_clerk_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT name INTO v_member_name FROM public.users WHERE id = v_user_id;

  -- Present on the marked_unavailable path (the PUT upsert writes the
  -- is_available: false row, and its note, before this RPC runs); NULL on
  -- the availability_deleted path because the row is already gone by the
  -- time this RPC runs — that is correct, "reason if provided".
  SELECT note INTO v_reason FROM public.availability
  WHERE user_id = v_user_id AND date = p_date;

  -- Usually at most one service_week per date, but loop rather than assume
  -- uniqueness (no such constraint exists on service_weeks.service_date) —
  -- every accepted invitation on the date should surface its own conflict.
  FOR v_invitation IN
    SELECT i.id, sw.title, sw.service_date
    FROM public.invitations i
    JOIN public.service_weeks sw ON sw.id = i.service_week_id
    WHERE i.user_id = v_user_id
      AND i.status = 'accepted'
      AND sw.church_group_id = v_group_id
      AND sw.service_date = p_date
  LOOP
    INSERT INTO public.conflicts (church_group_id, invitation_id, triggered_by, trigger_reason)
    VALUES (v_group_id, v_invitation.id, v_user_id, p_trigger_reason)
    RETURNING id INTO v_conflict_id;
    v_triggered := true;

    v_service_label := coalesce(v_invitation.title, 'the service on ' || v_invitation.service_date);

    -- Notify every admin/set_leader in the group, excluding the triggering
    -- member themselves (no self-notification even if they hold that role).
    -- TODO(#58/#59): dispatch SMS + email to these recipients (Sprint 4).
    FOR v_recipient IN
      SELECT id FROM public.users
      WHERE church_group_id = v_group_id
        AND role IN ('admin', 'set_leader')
        AND id <> v_user_id
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_group_id, v_recipient.id, 'scheduling_conflict', 'Scheduling conflict',
         v_member_name || ' can no longer make ' || v_service_label
           || CASE WHEN v_reason IS NOT NULL THEN ' — reason: ' || v_reason ELSE '' END,
         'conflict', v_conflict_id);
    END LOOP;
  END LOOP;

  RETURN v_triggered;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_availability_conflict(date, text) TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.record_availability_conflict(date, text);
