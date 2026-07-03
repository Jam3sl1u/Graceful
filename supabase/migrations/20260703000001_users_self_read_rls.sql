-- Migration: users self-read RLS (bootstrap slice of #22)
-- TODO(#22): This is a bootstrap slice — full column- and row-level policies
-- land in #22. Only users SELECT self-read is added here so auth lookup is safe
-- before the full RLS pass.

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
