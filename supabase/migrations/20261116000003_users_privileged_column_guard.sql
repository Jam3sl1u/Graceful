-- Migration: Privileged-column guard on users — Issue #208 second review
--
-- Why this ships with the chat tables: every chat policy, the
-- is_chat_room_member() helper and the invitee update guard
-- (20261116000001 / 20261116000002) decide access from the caller's role and
-- church group, which auth_user_role() and auth_church_group_id() read from
-- the caller's users row. The Phase 1 UPDATE policies on users
-- (20260704000001_rls_policies.sql) scope which ROWS a caller may update but
-- not which COLUMNS, so identity and privilege columns were writable through
-- a direct update. Operator decision 2026-11-16: fix it in this PR.
--
-- What it does: a BEFORE UPDATE trigger that applies to direct updates made
-- as `authenticated`:
--   * id, clerk_id and church_group_id can never be changed;
--   * role can only be changed by a caller whose current role is admin
--     (the rule app/api/church-group/members/[id]/role/handler.ts already
--     enforces; the last-admin rule BR-12 stays in that handler).
-- Every other column (name, email, phone, sms_opted_in, ...) behaves exactly
-- as before for members, set leaders and admins.
--
-- What it does NOT touch:
--   * the SECURITY DEFINER RPCs that write users (create_church_group,
--     join_church_group, provision_guest_user, claim_guest_invitation,
--     remove_church_group_member, ...) and the service role / Clerk webhook — inside
--     those, current_user is not `authenticated`, so the guard does not
--     apply. Group membership therefore still changes only through them.
--
-- Column privileges were not used because the admin role-change handler
-- updates users.role with a user JWT.
--
-- No applied Phase 1 migration is edited. Applying this migration to
-- staging/production is a human step.

-- ============ UP ============

-- SECURITY INVOKER on purpose: current_user must be the role that issued the
-- UPDATE. auth_user_role() is STABLE, so inside this trigger it still sees
-- the caller's role as it was before the statement began.
CREATE OR REPLACE FUNCTION public.users_guard_privileged_columns()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clerk_id IS DISTINCT FROM OLD.clerk_id
     OR NEW.church_group_id IS DISTINCT FROM OLD.church_group_id THEN
    RAISE EXCEPTION 'id, clerk_id and church_group_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     AND public.auth_user_role() IS DISTINCT FROM 'admin'::public.user_role THEN
    RAISE EXCEPTION 'only an admin can change a role'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_guard_privileged_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_guard_privileged_columns();

-- ============ DOWN ============
-- DROP TRIGGER IF EXISTS users_guard_privileged_columns ON public.users;
-- DROP FUNCTION IF EXISTS public.users_guard_privileged_columns();
