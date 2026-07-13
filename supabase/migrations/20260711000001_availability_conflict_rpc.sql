-- Migration: availability conflict-detection RPC — Issue #35 (BR-15)
--
-- DELETE /api/availability/:date (a quiet "unset") must trigger the same
-- conflict-detection flow as explicitly marking a date unavailable (#46):
-- if the caller has an accepted invitation for a service on that date, a
-- conflicts row must be recorded so a Set Leader isn't left unaware.
--
-- conflicts has no authenticated INSERT policy for plain members
-- (conflicts_insert_leader_admin in 20260704000001_rls_policies.sql is
-- leader/admin only) — a member clearing their OWN availability can't
-- record a conflict about their OWN accepted invitation under plain RLS.
-- Mirrors write_audit_log's shape (20260707000001_audit_log_write_rpc.sql):
-- a SECURITY DEFINER RPC that derives user_id/church_group_id from the
-- caller's JWT (never from arguments) and only ever INSERTs into conflicts,
-- so it can't be used to forge a conflict for another user or group.
--
-- Deliberately factored out of the availability DELETE itself (which stays
-- a plain RLS-scoped `.delete()` from the route handler — own-row DELETE is
-- already permitted by availability_delete_own) so this same RPC can be
-- called from the explicit "mark unavailable" PUT path too (#46), keeping
-- BR-15 enforcement in exactly one place regardless of trigger path.

-- ============ UP ============

-- public.record_availability_conflict(p_date, p_trigger_reason): for the
-- caller's own user + church group (derived from JWT), finds every accepted
-- invitation to a service on p_date and records a conflicts row for each.
-- Returns true iff at least one conflict was recorded. p_trigger_reason is
-- caller-supplied free text (e.g. "availability_deleted",
-- "marked_unavailable") stored on conflicts.trigger_reason for auditability.
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
  v_clerk_id  text;
  v_user_id   uuid;
  v_group_id  uuid;
  v_invitation record;
  v_triggered boolean := false;
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

  -- Usually at most one service_week per date, but loop rather than assume
  -- uniqueness (no such constraint exists on service_weeks.service_date) —
  -- every accepted invitation on the date should surface its own conflict.
  FOR v_invitation IN
    SELECT i.id
    FROM public.invitations i
    JOIN public.service_weeks sw ON sw.id = i.service_week_id
    WHERE i.user_id = v_user_id
      AND i.status = 'accepted'
      AND sw.church_group_id = v_group_id
      AND sw.service_date = p_date
  LOOP
    INSERT INTO public.conflicts (church_group_id, invitation_id, triggered_by, trigger_reason)
    VALUES (v_group_id, v_invitation.id, v_user_id, p_trigger_reason);
    v_triggered := true;
  END LOOP;

  RETURN v_triggered;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_availability_conflict(date, text) TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.record_availability_conflict(date, text);
