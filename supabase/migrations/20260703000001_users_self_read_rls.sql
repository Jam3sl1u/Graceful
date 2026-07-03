-- Migration: users self-read RLS (bootstrap slice of #22)
-- Bootstrap slice superseded by 20260704000001_rls_policies.sql (#22).
-- This migration only added users SELECT self-read so auth lookup was safe
-- before the full RLS pass. The new migration drops users_select_own and
-- replaces it with full group-scoped policies.

-- ============ UP ============

alter table users enable row level security;

-- Allow each authenticated user to SELECT only their own row.
-- Relies on Clerk JWT sub claim equalling users.clerk_id (Clerk default userId format).
create policy users_select_own
  on users
  for select
  to authenticated
  using (clerk_id = (auth.jwt() ->> 'sub'));

-- ============ DOWN ============
-- (commented; run to reverse)
-- drop policy if exists users_select_own on users;
-- alter table users disable row level security;
