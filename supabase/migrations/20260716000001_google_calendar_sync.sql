-- Migration: Google Calendar event sync — Issue #62
--
-- Event create/update/delete (app/api/events/**) and attendee add/remove
-- (app/api/events/[id]/attendees/**) are admin/set_leader-only actions whose
-- Supabase client runs under the ACTING user's Clerk JWT. google_calendar_tokens
-- is strictly user-scoped by RLS (google_calendar_tokens_select_own,
-- 20260704000001_rls_policies.sql) — an admin's request cannot read the
-- assigned members' encrypted tokens to push events to their calendars under
-- plain RLS. This migration adds SECURITY DEFINER RPCs for that cross-user
-- read, mirroring record_availability_conflict
-- (20260713000001_conflict_notification.sql) and remove_church_group_member
-- (20260710000001_member_removal_rpc.sql): the caller-role check inside the
-- function body (not RLS) is the actual enforcement point.
--
-- Also adds `is_valid` to google_calendar_tokens (PRD §10: "Token flagged as
-- invalid in DB" when a refresh is revoked) and the notification_type value
-- for the re-auth prompt, mirroring
-- 20260711000002_service_week_notification_types.sql.

-- ============ UP ============

ALTER TABLE public.google_calendar_tokens
  ADD COLUMN is_valid boolean NOT NULL DEFAULT true;

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'google_calendar_reauth_required';

-- public.get_event_sync_targets(p_event_id): for an event in the caller's own
-- church group, where the caller is admin/set_leader, returns one row per
-- assigned attendee (event_attendees) who has a connected + valid Google
-- Calendar token. Used by lib/google-calendar/sync.ts (syncEventToAttendees /
-- unsyncEventFromAttendees) to push event create/update/delete to every
-- assigned member's calendar without the acting admin ever reading a token
-- directly.
CREATE OR REPLACE FUNCTION public.get_event_sync_targets(p_event_id uuid)
  RETURNS TABLE (
    user_id uuid,
    access_token_encrypted text,
    refresh_token_encrypted text,
    token_expiry timestamptz,
    calendar_id text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id       text;
  v_caller_id      uuid;
  v_caller_group   uuid;
  v_caller_role    public.user_role;
  v_event_group_id uuid;
BEGIN
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, church_group_id, role INTO v_caller_id, v_caller_group, v_caller_role
  FROM public.users WHERE clerk_id = v_clerk_id;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF v_caller_role NOT IN ('admin', 'set_leader') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  SELECT e.church_group_id INTO v_event_group_id
  FROM public.events e
  WHERE e.id = p_event_id;

  IF v_event_group_id IS NULL OR v_event_group_id <> v_caller_group THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT t.user_id, t.access_token_encrypted, t.refresh_token_encrypted,
         t.token_expiry, t.calendar_id
  FROM public.event_attendees ea
  JOIN public.google_calendar_tokens t ON t.user_id = ea.user_id
  WHERE ea.event_id = p_event_id
    AND t.is_valid = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_event_sync_targets(uuid) TO authenticated;

-- public.get_user_sync_targets(): same row shape as get_event_sync_targets,
-- but for the CALLER's own connected + valid token only (0 or 1 row). Used by
-- the reconnect retroactive-sync path (syncAllEventsForUser), where the
-- acting user reads their own token — no RLS wall, but kept as an RPC so both
-- sync paths share one code path/row shape.
CREATE OR REPLACE FUNCTION public.get_user_sync_targets()
  RETURNS TABLE (
    user_id uuid,
    access_token_encrypted text,
    refresh_token_encrypted text,
    token_expiry timestamptz,
    calendar_id text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id  text;
  v_caller_id uuid;
BEGIN
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_caller_id FROM public.users WHERE clerk_id = v_clerk_id;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT t.user_id, t.access_token_encrypted, t.refresh_token_encrypted,
         t.token_expiry, t.calendar_id
  FROM public.google_calendar_tokens t
  WHERE t.user_id = v_caller_id
    AND t.is_valid = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_sync_targets() TO authenticated;

-- public.flag_calendar_token_invalid(p_user_id): marks a member's Google
-- Calendar token invalid (revoked/expired refresh) and inserts an in-app
-- re-auth notification for them, mirroring the notification INSERT shape in
-- record_availability_conflict. Caller must be admin/set_leader in the same
-- church group as the target OR be flagging their own token (self path).
-- Idempotent: a no-op (returns false) when there is no token row, or it is
-- already flagged invalid, so a repeated sync failure never sends a repeat
-- notification.
CREATE OR REPLACE FUNCTION public.flag_calendar_token_invalid(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id        text;
  v_caller_id       uuid;
  v_caller_group    uuid;
  v_caller_role     public.user_role;
  v_target_group    uuid;
  v_currently_valid boolean;
BEGIN
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, church_group_id, role INTO v_caller_id, v_caller_group, v_caller_role
  FROM public.users WHERE clerk_id = v_clerk_id;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT church_group_id INTO v_target_group
  FROM public.users WHERE id = p_user_id;

  IF v_target_group IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id <> v_caller_id
     AND NOT (v_caller_role IN ('admin', 'set_leader') AND v_caller_group = v_target_group) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  SELECT is_valid INTO v_currently_valid
  FROM public.google_calendar_tokens
  WHERE user_id = p_user_id;

  -- No token row, or already flagged invalid: nothing to do (idempotent, no
  -- repeat notification).
  IF v_currently_valid IS NULL OR v_currently_valid = false THEN
    RETURN false;
  END IF;

  UPDATE public.google_calendar_tokens
  SET is_valid = false, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.notifications
    (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
  VALUES
    (v_target_group, p_user_id, 'google_calendar_reauth_required', 'Reconnect Google Calendar',
     'Your Google Calendar connection needs to be refreshed. Tap here to reconnect.',
     'google_calendar', NULL);

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.flag_calendar_token_invalid(uuid) TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.flag_calendar_token_invalid(uuid);
-- DROP FUNCTION IF EXISTS public.get_user_sync_targets();
-- DROP FUNCTION IF EXISTS public.get_event_sync_targets(uuid);
-- (notification_type enum value cannot be dropped directly — see
-- 20260711000002_service_week_notification_types.sql for the same caveat.)
-- ALTER TABLE public.google_calendar_tokens DROP COLUMN IF EXISTS is_valid;
