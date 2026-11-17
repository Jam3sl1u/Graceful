-- Migration: Invitee-side invitation update guard — Issue #208 review finding 2
--
-- Why this ships with the chat tables: is_chat_room_member()
-- (20261116000001_chat_tables_rls.sql) trusts invitations.status = 'accepted'
-- and invitations.service_week_id. The Phase 1 policy invitations_update_own
-- (20260704000001_rls_policies.sql) lets an invitee UPDATE any column of
-- their own row, so a denied or withdrawn invitee could set their row back
-- to 'accepted', or re-point it at another service week, straight through
-- PostgREST and gain that week's chat. Operator decision 2026-11-16: fix it
-- in this PR rather than track it separately.
--
-- What it does: a BEFORE UPDATE trigger that restricts what an invitee may
-- change on their own invitation when updating directly as `authenticated`:
--   * only status, denial_reason, denial_count and responded_at may change;
--   * status may only move pending -> denied;
--   * if status does not change, nothing may change.
-- Accepting is deliberately NOT allowed as a direct update: accept_invitation()
-- is the only path that enforces the response deadline and writes the roster
-- rows, the admin notification and the audit entry, and the app never accepts
-- any other way (app/api/invitations/handler.ts calls the RPC).
--
-- What it does NOT touch:
--   * leaders and admins (invitations_update_leader_admin) — unrestricted, so
--     withdraw and conflict resolution behave as before;
--   * the SECURITY DEFINER RPCs (accept_invitation, deny_invitation,
--     send_invitation_reminders, ...) and the service role — inside those,
--     current_user is the function owner, not `authenticated`, so the guard
--     does not apply;
--   * the session deny path in app/api/invitations/handler.ts, which changes
--     exactly the four allowed columns on a pending row.
--
-- The comparison uses to_jsonb(row) minus the allowed keys, so any column
-- added to invitations later is immutable to invitees by default.
--
-- No applied Phase 1 migration is edited. Applying this migration to
-- staging/production is a human step.

-- ============ UP ============

-- SECURITY INVOKER on purpose: current_user must be the role that issued the
-- UPDATE, which is how a direct PostgREST update is told apart from an RPC.
CREATE OR REPLACE FUNCTION public.invitations_guard_invitee_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'denial_reason', 'denial_count', 'responded_at'];
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(public.auth_is_leader_or_admin(), false) THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'invitees may only change their response on an invitation'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' OR NEW.status <> 'denied' THEN
      RAISE EXCEPTION 'an invitee may only decline a pending invitation directly'
        USING ERRCODE = '42501';
    END IF;
  ELSIF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'an answered invitation cannot be changed by its invitee'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invitations_guard_invitee_update
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW
  EXECUTE FUNCTION public.invitations_guard_invitee_update();

-- ============ DOWN ============
-- DROP TRIGGER IF EXISTS invitations_guard_invitee_update ON public.invitations;
-- DROP FUNCTION IF EXISTS public.invitations_guard_invitee_update();
