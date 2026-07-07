-- Migration: church_group join RPC — Issue #25
-- Mirrors 20260706000001_church_group_create_rpc.sql: the joiner has no
-- users row yet, so requireAuth and the authenticated INSERT policies do
-- not apply. Runs the whole join as one atomic SECURITY DEFINER function,
-- called by the RLS-scoped anon client with the joiner's Clerk JWT.
--
-- Also adds `church_groups.invite_code_expires_at` (nullable timestamptz):
-- NULL means the code never expires (the default for every code created by
-- create_church_group today). A non-null value in the past means the code
-- is expired/revoked; join_church_group() treats that identically to an
-- unknown code so the API-level error message and status stay unchanged
-- ("Invalid or expired invite code", 400). Setting this column to `now()`
-- (or any past timestamp) is also how an admin can manually revoke a code
-- before its natural expiry — there is no separate revoked_at column.

-- ============ UP ============

ALTER TABLE public.church_groups
  ADD COLUMN invite_code_expires_at timestamptz;

-- public.join_church_group(...): resolves the invite code to a church group,
-- rejects unknown/expired/revoked codes and joiners who already belong to a
-- group, and provisions the joiner as a 'member'. Runs SECURITY DEFINER for
-- the same reason as create_church_group.
CREATE OR REPLACE FUNCTION public.join_church_group(
  p_invite_code text,
  p_member_name text,
  p_member_email text
)
  RETURNS public.users
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_group_id uuid;
  v_invite_code_expires_at timestamptz;
  v_user public.users%ROWTYPE;
BEGIN
  -- 1. auth
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 2. reject users already in a group (users.clerk_id is unique)
  IF EXISTS (SELECT 1 FROM public.users WHERE clerk_id = v_clerk_id) THEN
    RAISE EXCEPTION 'USER_ALREADY_IN_GROUP' USING ERRCODE = 'P0001';
  END IF;

  -- 3. resolve the group from the invite code
  SELECT id, invite_code_expires_at INTO v_group_id, v_invite_code_expires_at
  FROM public.church_groups
  WHERE invite_code = p_invite_code;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_INVITE_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- 4. reject expired/revoked codes. NULL means the code never expires.
  IF v_invite_code_expires_at IS NOT NULL AND v_invite_code_expires_at <= now() THEN
    RAISE EXCEPTION 'INVALID_INVITE_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- 5. provision the member
  INSERT INTO public.users (clerk_id, church_group_id, role, name, email)
  VALUES (v_clerk_id, v_group_id, 'member', p_member_name, p_member_email)
  RETURNING * INTO v_user;

  RETURN v_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_church_group(text, text, text) TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.join_church_group(text, text, text);
-- ALTER TABLE public.church_groups DROP COLUMN IF EXISTS invite_code_expires_at;
