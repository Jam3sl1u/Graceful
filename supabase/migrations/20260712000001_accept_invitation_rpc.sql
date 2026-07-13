-- Migration: accept_invitation RPC — Issue #41
--
-- POST /api/invitations/:id/accept must work two ways: (1) no-session
-- (SMS/email link) — a `response_token` in the body and no Clerk session, and
-- (2) in-app — an authenticated member accepting their own invitation, no
-- token. The service-role key is banned in app/ and lib/
-- (scripts/check-service-role.mjs), so the no-session path has no JWT and
-- must run as the `anon` role through a SECURITY DEFINER function that
-- authenticates via the token itself.
--
-- Acceptance also needs to INSERT into notifications (admin notify),
-- event_attendees, and audit_logs — none of which a plain `member` may write
-- under RLS (20260704000001_rls_policies.sql): notifications_insert_leader_admin
-- is leader/admin only, and audit_logs has no authenticated INSERT policy.
-- Doing the whole operation in one SECURITY DEFINER RPC keeps it atomic and
-- mirrors record_availability_conflict (20260711000001_availability_conflict_rpc.sql)
-- and write_audit_log (20260707000001_audit_log_write_rpc.sql).

-- ============ UP ============

-- public.accept_invitation(p_invitation_id, p_response_token): validates and
-- accepts an invitation via either a matching response_token (no-session
-- path, p_response_token IS NOT NULL) or the caller's own Clerk session
-- (p_response_token IS NULL, acting user must be the invitation's user_id).
-- Already-responded invitations return gracefully (not an error) with the
-- current status; expired-but-still-pending invitations raise EXPIRED.
-- On success: flips status to accepted, inserts one event_attendees row per
-- event of the invitation's service week (idempotent), notifies the inviting
-- admin/set_leader (or all admins/set_leaders in the group if invited_by is
-- null), and appends an audit_logs row with time-to-respond metadata.
CREATE OR REPLACE FUNCTION public.accept_invitation(
  p_invitation_id   uuid,
  p_response_token  text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_inv              public.invitations%ROWTYPE;
  v_clerk_id         text;
  v_caller_id        uuid;
  v_via              text;
  v_attendees_added  int;
  v_member_name      text;
  v_recipient        record;
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
    v_via := 'token';
  ELSE
    v_clerk_id := auth.jwt() ->> 'sub';
    IF v_clerk_id IS NULL THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_caller_id FROM public.users WHERE clerk_id = v_clerk_id;
    IF v_caller_id IS NULL OR v_caller_id <> v_inv.user_id THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    v_via := 'session';
  END IF;

  -- Already responded (graceful, not an error): covers accepted/denied/withdrawn.
  IF v_inv.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'status', v_inv.status,
      'already_responded', true,
      'attendees_added', 0
    );
  END IF;

  -- Expiry (checked after the already-responded check, so a previously
  -- accepted-but-now-past invite still returns 200 accepted above).
  IF v_inv.response_deadline IS NOT NULL AND now() > v_inv.response_deadline THEN
    RAISE EXCEPTION 'EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.invitations
  SET status = 'accepted', responded_at = now()
  WHERE id = p_invitation_id;

  -- event_attendees for every event of the week (idempotent; no-op when the
  -- week has no events yet — queued for #59/#60).
  INSERT INTO public.event_attendees (event_id, user_id)
  SELECT e.id, v_inv.user_id FROM public.events e
  WHERE e.service_week_id = v_inv.service_week_id
  ON CONFLICT (event_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_attendees_added = ROW_COUNT;

  -- Notify admin in-app: the inviting user if known, else every admin/
  -- set_leader in the group.
  SELECT name INTO v_member_name FROM public.users WHERE id = v_inv.user_id;

  IF v_inv.invited_by IS NOT NULL THEN
    INSERT INTO public.notifications
      (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
    VALUES
      (v_inv.church_group_id, v_inv.invited_by, 'invitation_accepted', 'Invitation accepted',
       v_member_name || ' accepted their set invitation', 'invitation', v_inv.id);
  ELSE
    FOR v_recipient IN
      SELECT id FROM public.users
      WHERE church_group_id = v_inv.church_group_id
        AND role IN ('admin', 'set_leader')
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_inv.church_group_id, v_recipient.id, 'invitation_accepted', 'Invitation accepted',
         v_member_name || ' accepted their set invitation', 'invitation', v_inv.id);
    END LOOP;
  END IF;

  -- Audit log (insert directly — this is the no-session-safe equivalent of
  -- write_audit_log, which cannot be used here because it derives identity
  -- from the JWT).
  INSERT INTO public.audit_logs (church_group_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (v_inv.church_group_id, v_inv.user_id, 'invitation.accepted', 'invitation', v_inv.id,
    jsonb_build_object(
      'time_to_respond_seconds', floor(extract(epoch FROM (now() - v_inv.created_at)))::int,
      'via', v_via));

  -- TODO(#62): Google Calendar sync on accept.

  RETURN jsonb_build_object(
    'status', 'accepted',
    'already_responded', false,
    'attendees_added', v_attendees_added
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_invitation(uuid, text) TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.accept_invitation(uuid, text);
