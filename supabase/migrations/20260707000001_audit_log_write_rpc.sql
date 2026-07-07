-- Migration: audit_logs write RPC — Issue #29
-- audit_logs (20260702000006_cluster6_auth_audit.sql) has no authenticated
-- INSERT policy — inserts are documented as "via service role / triggers
-- only" — and the service-role key is forbidden in app/ and lib/
-- (scripts/check-service-role.mjs). UPDATE/DELETE are REVOKEd from
-- authenticated/anon and must stay that way (append-only).
--
-- Solution: a SECURITY DEFINER RPC, called by the normal RLS-scoped anon
-- client, that only ever INSERTs. user_id and church_group_id are derived
-- from the caller's JWT (never from caller-supplied arguments) so a route
-- cannot forge a log entry attributed to another user or group. Mirrors
-- 20260706000001_church_group_create_rpc.sql.

-- ============ UP ============

-- public.write_audit_log(...): appends one immutable audit_logs row for the
-- caller's own user + church group. Runs SECURITY DEFINER because
-- `authenticated` has no INSERT policy on audit_logs; this function only
-- ever INSERTs (UPDATE/DELETE stay revoked at the table level).
CREATE OR REPLACE FUNCTION public.write_audit_log(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_metadata    jsonb
)
  RETURNS public.audit_logs
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_user_id  uuid;
  v_group_id uuid;
  v_row      public.audit_logs%ROWTYPE;
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

  INSERT INTO public.audit_logs
    (church_group_id, user_id, action, entity_type, entity_id, metadata)
  VALUES
    (v_group_id, v_user_id, p_action, p_entity_type, p_entity_id,
     COALESCE(p_metadata, '{}'::jsonb))
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.write_audit_log(text, text, uuid, jsonb) TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.write_audit_log(text, text, uuid, jsonb);
