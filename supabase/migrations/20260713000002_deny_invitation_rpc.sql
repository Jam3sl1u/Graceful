-- Migration: deny_invitation RPC — Issue #49
--
-- POST /api/invitations/:id/deny must also work no-session (SMS/email link
-- tap on the Invitation Response screen, #49), mirroring accept_invitation
-- (20260712000001_accept_invitation_rpc.sql): a `response_token` in the body
-- and no Clerk session runs through a SECURITY DEFINER function as the
-- `anon` role, authenticated via the token itself, since the service-role
-- key is banned in app/ and lib/ (scripts/check-service-role.mjs). The
-- existing authenticated in-app deny path (#42, handler.ts denyInvitation)
-- is untouched — this RPC is additive, invoked only from the new
-- responseToken branch.
--
-- Denial also needs to INSERT into notifications (admin notify) and
-- audit_logs — neither of which a plain `member` (let alone the anon role)
-- may write under RLS (20260704000001_rls_policies.sql). Doing the whole
-- operation in one SECURITY DEFINER RPC keeps it atomic.

-- ============ UP ============

-- public.deny_invitation(p_invitation_id, p_response_token, p_reason):
-- validates and denies an invitation via either a matching response_token
-- (no-session path, p_response_token IS NOT NULL) or the caller's own Clerk
-- session (p_response_token IS NULL, acting user must be the invitation's
-- user_id). Already-responded invitations return gracefully (not an error)
-- with the current status; expired-but-still-pending invitations raise
-- EXPIRED. On success: flips status to denied, records the (optional)
-- denial reason and the BR-08 denial_count, notifies the inviting admin/
-- set_leader (or all admins/set_leaders in the group if invited_by is
-- null), and appends an audit_logs row.
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
      'already_responded', true
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

  IF v_inv.invited_by IS NOT NULL THEN
    INSERT INTO public.notifications
      (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
    VALUES
      (v_inv.church_group_id, v_inv.invited_by, 'invitation_denied', 'Invitation declined',
       v_member_name || ' declined their set invitation', 'invitation', v_inv.id);
  ELSE
    FOR v_recipient IN
      SELECT id FROM public.users
      WHERE church_group_id = v_inv.church_group_id
        AND role IN ('admin', 'set_leader')
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_inv.church_group_id, v_recipient.id, 'invitation_denied', 'Invitation declined',
         v_member_name || ' declined their set invitation', 'invitation', v_inv.id);
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

  -- TODO(#67/#68): dispatch SMS + email to invited_by (admin) with member name and reason.

  RETURN jsonb_build_object(
    'status', 'denied',
    'already_responded', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.deny_invitation(uuid, text, text) TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.deny_invitation(uuid, text, text);
