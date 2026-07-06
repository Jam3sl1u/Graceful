-- Migration: create_church_group SECURITY DEFINER bootstrap fn — Issue #24
-- Atomically creates a church_groups row, the creator's users row (role
-- 'admin'), and seeds the 9 default instruments — all in one transaction.
--
-- The caller is a brand-new Clerk user with no `users` row and no group yet,
-- so RLS denies direct INSERTs on church_groups/users/instruments for the
-- `authenticated` role. This SECURITY DEFINER function bypasses RLS inside
-- its own body (same pattern as the auth_* helpers in
-- 20260704000001_rls_policies.sql) while the route calls it via the
-- RLS-scoped Supabase client with the caller's JWT.

-- ============ UP ============

-- pgcrypto (gen_random_bytes) is already enabled by cluster 1's migration.

create or replace function public.create_church_group(
  p_name         text,
  p_timezone     text,
  p_denomination text,
  p_logo_url     text,
  p_user_name    text,
  p_user_email   text
) returns public.church_groups
  language plpgsql security definer
  set search_path = ''
as $$
declare
  v_clerk_id      text;
  v_group         public.church_groups;
  v_user_id       uuid;
  v_invite_code   text;
  v_alphabet      text := '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  v_alphabet_len  int := length(v_alphabet);
  i               int;
begin
  v_clerk_id := auth.jwt() ->> 'sub';
  if v_clerk_id is null then
    raise exception 'not authenticated' using errcode = 'GR000';
  end if;

  -- Already-a-member guard.
  if exists (select 1 from public.users where clerk_id = v_clerk_id) then
    raise exception 'user already belongs to a church group' using errcode = 'GR001';
  end if;

  -- Generate an 8-character, URL-safe, unambiguous invite code and insert,
  -- retrying transparently on the (only) unique_violation possible here.
  loop
    v_invite_code := '';
    for i in 1..8 loop
      v_invite_code := v_invite_code || substr(
        v_alphabet,
        (get_byte(gen_random_bytes(1), 0) % v_alphabet_len) + 1,
        1
      );
    end loop;

    begin
      insert into public.church_groups (name, timezone, denomination, logo_url, invite_code)
      values (p_name, p_timezone, p_denomination, p_logo_url, v_invite_code)
      returning * into v_group;
      exit;
    exception
      when unique_violation then
        -- invite_code collision: loop and try a new code.
        continue;
    end;
  end loop;

  -- Creator user row (role = admin).
  insert into public.users (clerk_id, church_group_id, role, name, email)
  values (v_clerk_id, v_group.id, 'admin', p_user_name, p_user_email)
  returning id into v_user_id;

  -- Seed the 9 default instruments (PRD §11).
  insert into public.instruments (church_group_id, name, is_default, created_by)
  values
    (v_group.id, 'Acoustic guitar', true, v_user_id),
    (v_group.id, 'Electric guitar', true, v_user_id),
    (v_group.id, 'Bass guitar', true, v_user_id),
    (v_group.id, 'Piano / keyboard', true, v_user_id),
    (v_group.id, 'Violin', true, v_user_id),
    (v_group.id, 'Vocalists', true, v_user_id),
    (v_group.id, 'Drums', true, v_user_id),
    (v_group.id, 'Cajon', true, v_user_id),
    (v_group.id, 'Other', true, v_user_id);

  return v_group;
end;
$$;

grant execute on function public.create_church_group(text, text, text, text, text, text) to authenticated;

-- ============ DOWN ============
-- drop function if exists public.create_church_group(text, text, text, text, text, text);
