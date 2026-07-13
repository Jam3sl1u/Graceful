-- Migration: get_invitation_by_token RPC — Issue #44
--
-- GET /api/invitations/respond/:token is a no-session, no-Clerk-auth
-- read-only endpoint that returns an invitation's details to someone
-- tapping an SMS/email link. Token possession is the only credential
-- (per #40). Direct table reads are impossible here: RLS on invitations,
-- service_weeks, and events grants SELECT only TO authenticated,
-- tenant-scoped (20260704000001_rls_policies.sql). A no-session caller is
-- the Postgres anon role and can read none of it. This mirrors the
-- accept_invitation RPC (20260712000001_accept_invitation_rpc.sql): a
-- SECURITY DEFINER function authenticated by the token itself, invoked
-- through getAnonSupabaseClient(). Unlike accept_invitation, this function
-- is read-only (STABLE, no mutation).

-- ============ UP ============

-- public.get_invitation_by_token(p_response_token): looks up an invitation
-- by its response_token and returns the invitation, its service week, and
-- the week's events as a single jsonb payload. A still-pending invitation
-- past its response_deadline is reported with a computed "expired" status
-- (an API-only derived state, not a DB enum value); already-responded rows
-- keep their real status (accepted/denied/withdrawn).
CREATE OR REPLACE FUNCTION public.get_invitation_by_token(p_response_token text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_inv    public.invitations%ROWTYPE;
  v_week   public.service_weeks%ROWTYPE;
  v_events jsonb;
  v_status text;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE response_token = p_response_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_week FROM public.service_weeks WHERE id = v_inv.service_week_id;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',         e.id,
        'type',       e.type,
        'name',       e.name,
        'location',   e.location,
        'start_time', e.start_time,
        'end_time',   e.end_time
      ) ORDER BY e.start_time
    ),
    '[]'::jsonb
  )
  INTO v_events
  FROM public.events e
  WHERE e.service_week_id = v_inv.service_week_id;

  -- Computed "expired" state: only a still-pending invitation past its deadline.
  -- Already-responded rows keep their real status (accepted/denied/withdrawn).
  IF v_inv.status = 'pending'
     AND v_inv.response_deadline IS NOT NULL
     AND now() > v_inv.response_deadline THEN
    v_status := 'expired';
  ELSE
    v_status := v_inv.status;
  END IF;

  RETURN jsonb_build_object(
    'invitation_id',     v_inv.id,
    'status',            v_status,
    'role_note',         v_inv.role_note,
    'response_deadline', v_inv.response_deadline,
    'service_week', jsonb_build_object(
      'id',           v_week.id,
      'service_date', v_week.service_date,
      'title',        v_week.title
    ),
    'events', v_events
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invitation_by_token(text) TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.get_invitation_by_token(text);
