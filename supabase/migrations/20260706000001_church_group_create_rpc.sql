-- Migration: church_group creation RPC — Issue #24
-- The existing RLS model blocks every naive PUT /api/church-group
-- implementation: church_groups and users have no authenticated INSERT
-- policy (provisioning is service-role / webhook only), and a brand-new
-- creator has no users row yet so auth_church_group_id() is null. The
-- service-role key is forbidden in app/ and lib/ (scripts/check-service-role.mjs).
--
-- Solution: run the entire creation as one atomic SECURITY DEFINER function,
-- called by the RLS-scoped anon client with the creator's Clerk JWT. Mirrors
-- the SECURITY DEFINER helpers in 20260704000001_rls_policies.sql.

-- ============ UP ============

-- public.generate_invite_code(): 8-character, URL-safe, unambiguous invite
-- code. Alphabet excludes 0/O/1/I/L. Loops until a unique code is found.
CREATE OR REPLACE FUNCTION public.generate_invite_code()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_exists boolean;
BEGIN
  LOOP
    v_code := (
      SELECT string_agg(substr(v_alphabet, (floor(random() * length(v_alphabet)) + 1)::int, 1), '')
      FROM generate_series(1, 8)
    );

    SELECT EXISTS(
      SELECT 1 FROM public.church_groups WHERE invite_code = v_code
    ) INTO v_exists;

    EXIT WHEN NOT v_exists;
  END LOOP;

  RETURN v_code;
END;
$$;

-- public.create_church_group(...): atomically creates a church_groups row,
-- provisions the creator as its admin users row, and seeds the 8 default
-- instruments. Runs SECURITY DEFINER because the creator has no users row
-- yet (requireAuth cannot be used), and neither church_groups nor users has
-- an authenticated INSERT policy.
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
    'Cajon'
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

GRANT EXECUTE ON FUNCTION public.create_church_group(text, text, text, text, text, text)
  TO authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.create_church_group(text, text, text, text, text, text);
-- DROP FUNCTION IF EXISTS public.generate_invite_code();
