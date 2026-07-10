-- Migration: member removal / PII anonymization RPC — Issue #28
-- DELETE /api/church-group/members/:id is a right-to-erasure pattern, not a
-- hard delete: invitations.user_id and event_attendees.user_id are ON DELETE
-- CASCADE to users (20260702000003_cluster_3_scheduling_core.sql), so a real
-- DELETE FROM users would destroy exactly the historical setlist/scheduling
-- participation PRD §25.6 requires to survive (for the future AI training
-- pipeline). Anonymize the row in place instead, keeping the same users.id.
--
-- Several tables that need clearing for ANOTHER user (notification_preferences,
-- notifications, google_calendar_tokens) have RLS policies scoped to
-- user_id = auth_user_id() only (or no DELETE policy at all, for
-- notifications) — an admin's plain RLS-scoped client cannot clear them for
-- someone else. Combined with BR-12 needing an atomic last-admin check (to
-- avoid a TOCTOU race if two admins are removed concurrently), this runs as
-- one atomic SECURITY DEFINER function, mirroring
-- 20260706000002_church_group_join_rpc.sql's join_church_group shape.
--
-- BR-12 is also enforced (for demotion) in patchMemberRole
-- (app/api/church-group/members/[id]/role/handler.ts) — keep both in sync.

-- ============ UP ============

ALTER TABLE public.users
  ADD COLUMN anonymized_at timestamptz;

-- Excludes anonymized members from the active roster without a full-group
-- scan; app-layer queries add `.is("anonymized_at", null)`.
CREATE INDEX idx_users_church_group_id_active
  ON public.users (church_group_id)
  WHERE anonymized_at IS NULL;

-- public.remove_church_group_member(...): admin-only removal of a member.
-- Anonymizes name/email/phone/clerk_id in place (clerk_id is the actual
-- access-revocation lever — every RLS policy resolves identity via
-- clerk_id = auth.jwt()->>'sub', so overwriting it is what actually revokes
-- access), deletes future-schedule-only rows (member_profiles cascades
-- member_instruments; availability; notification_preferences; notifications;
-- google_calendar_tokens), and deliberately leaves invitations,
-- event_attendees, setlists.created_by, events.created_by,
-- service_weeks.created_by, and conflicts.* pointing at the now-anonymized
-- users.id row, so historical participation stays intact and joinable.
--
-- SECURITY DEFINER because it must bypass the owner-only RLS on
-- notification_preferences/notifications/google_calendar_tokens to clear
-- another user's rows; the caller-role check below (not RLS) is therefore
-- the actual "Admin only" enforcement for this function.
CREATE OR REPLACE FUNCTION public.remove_church_group_member(
  p_target_user_id uuid
)
  RETURNS public.users
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_caller_group uuid;
  v_caller_role public.user_role;
  v_target public.users%ROWTYPE;
  v_admin_count integer;
  v_user public.users%ROWTYPE;
BEGIN
  -- 1. auth
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT church_group_id, role INTO v_caller_group, v_caller_role
  FROM public.users
  WHERE clerk_id = v_clerk_id;

  IF v_caller_group IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 2. admin only. SECURITY DEFINER bypasses RLS, so this app-level check is
  -- the real enforcement point for this function, not defense in depth.
  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  -- 3+4. Lock the target row AND every current admin row in the group in
  -- ONE statement, ordered by id, before reading anything. Two separate
  -- FOR UPDATE queries (target first, admin-set second) would let two
  -- concurrent removals of two different admins each hold one lock and
  -- wait on the other (classic deadlock: T1 locks X then wants Y, T2 locks
  -- Y then wants X). Locking the full {target} UNION {admins} row set in a
  -- single ORDER BY id FOR UPDATE query gives every concurrent call against
  -- the same church group the same lock-acquisition order, so they queue
  -- instead of deadlocking, and the later transaction always re-reads the
  -- first transaction's committed result before proceeding — this is what
  -- actually closes the BR-12 TOCTOU race, not a bare COUNT(*).
  PERFORM 1
  FROM public.users
  WHERE church_group_id = v_caller_group
    AND anonymized_at IS NULL
    AND (id = p_target_user_id OR role = 'admin')
  ORDER BY id
  FOR UPDATE;

  -- Missing / wrong-group / already-anonymized are all indistinguishable by
  -- construction, matching the 404-not-403 convention used elsewhere
  -- (role/handler.ts) so cross-tenant existence isn't leaked. Re-removing an
  -- already-anonymized member also 404s (not a no-op).
  SELECT * INTO v_target
  FROM public.users
  WHERE id = p_target_user_id
    AND church_group_id = v_caller_group
    AND anonymized_at IS NULL;

  IF v_target.id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- BR-12: cannot remove the last remaining admin without reassigning admin
  -- elsewhere first. Safe to read without FOR UPDATE here — the PERFORM
  -- above already holds locks on every admin row in the group.
  IF v_target.role = 'admin' THEN
    SELECT count(*) INTO v_admin_count
    FROM public.users
    WHERE church_group_id = v_caller_group
      AND role = 'admin'
      AND anonymized_at IS NULL;

    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'LAST_ADMIN' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 5. anonymize in place. role is downgraded to 'guest' so a removed
  -- admin's row can never satisfy an admin-count check elsewhere again.
  UPDATE public.users
  SET name = 'Deleted User',
      email = NULL,
      phone = NULL,
      sms_opted_in = false,
      clerk_id = 'deleted-' || p_target_user_id::text,
      role = 'guest',
      anonymized_at = now(),
      updated_at = now()
  WHERE id = p_target_user_id
  RETURNING * INTO v_user;

  -- 6. clear future/PII-adjacent data with no historical value.
  -- member_profiles cascades member_instruments.
  DELETE FROM public.member_profiles WHERE user_id = p_target_user_id;
  DELETE FROM public.availability WHERE user_id = p_target_user_id;
  DELETE FROM public.notification_preferences WHERE user_id = p_target_user_id;
  DELETE FROM public.notifications WHERE user_id = p_target_user_id;
  DELETE FROM public.google_calendar_tokens WHERE user_id = p_target_user_id;

  RETURN v_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_church_group_member(uuid) TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.remove_church_group_member(uuid);
-- DROP INDEX IF EXISTS public.idx_users_church_group_id_active;
-- ALTER TABLE public.users DROP COLUMN IF EXISTS anonymized_at;
