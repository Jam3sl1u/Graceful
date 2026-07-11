-- Migration: fix missing 9th default instrument — Issue #24 follow-up
-- create_church_group() (20260706000001) seeded only 8 of the 9 required
-- default instruments per PRD §21.1 / issue #17's implementation notes; the
-- catch-all "Other" instrument was omitted. Fixes forward: corrects the RPC
-- for future group creations and backfills existing groups. Additive only —
-- no destructive changes to existing instrument rows.

-- ============ UP ============

CREATE OR REPLACE FUNCTION public.create_church_group(
  p_name text,
  p_timezone text,
  p_denomination text,
  p_logo_url text,
  p_creator_name text,
  p_creator_email text
)
  RETURNS public.church_groups
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_group public.church_groups%ROWTYPE;
  v_default_instruments text[] := ARRAY[
    'Acoustic guitar',
    'Electric guitar',
    'Bass guitar',
    'Piano/keyboard',
    'Violin',
    'Vocalists',
    'Drums',
    'Cajon',
    'Other'
  ];
  v_instrument_name text;
BEGIN
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE clerk_id = v_clerk_id) THEN
    RAISE EXCEPTION 'USER_ALREADY_IN_GROUP' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.church_groups (name, denomination, timezone, logo_url, invite_code)
  VALUES (p_name, p_denomination, p_timezone, p_logo_url, public.generate_invite_code())
  RETURNING * INTO v_group;

  INSERT INTO public.users (clerk_id, church_group_id, role, name, email)
  VALUES (v_clerk_id, v_group.id, 'admin', p_creator_name, p_creator_email);

  FOREACH v_instrument_name IN ARRAY v_default_instruments
  LOOP
    INSERT INTO public.instruments (church_group_id, name, is_default, created_by)
    VALUES (v_group.id, v_instrument_name, true, NULL);
  END LOOP;

  RETURN v_group;
END;
$$;

-- Backfill: any church group created before this migration is missing the
-- "Other" default. Idempotent — safe to re-run.
INSERT INTO public.instruments (church_group_id, name, is_default, created_by)
SELECT cg.id, 'Other', true, NULL
FROM public.church_groups cg
WHERE NOT EXISTS (
  SELECT 1 FROM public.instruments i
  WHERE i.church_group_id = cg.id AND i.name = 'Other'
);

-- ============ DOWN ============
-- DELETE FROM public.instruments WHERE name = 'Other' AND is_default = true AND created_by IS NULL;
-- (Restoring the prior 8-item CREATE OR REPLACE FUNCTION body is intentionally omitted —
-- reverting to a known-incomplete seed list is not a real rollback target.)
