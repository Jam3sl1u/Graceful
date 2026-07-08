-- Migration: chat_rooms placeholder — Issue #37
-- PRD Flow 4 / the issue AC require that creating a service week auto-creates
-- an inactive chat room placeholder alongside the draft setlist. Full chat
-- functionality (messages, mentions, activation) is still Phase 2 — see
-- 20260702000005_cluster_5_partial.sql's header comment — so this migration
-- adds only the minimal columns needed to hold an inactive placeholder row
-- linked 1:1 to a service_weeks row. Do NOT add chat_messages/chat_mentions
-- or any messaging columns here.
--
-- Depends on Cluster 1 (church_groups, users) and Cluster 3 (service_weeks),
-- both already applied.

-- ============ UP ============

create table chat_rooms (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  service_week_id uuid not null unique references service_weeks(id) on delete cascade,
  is_active boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.chat_rooms enable row level security;

-- SELECT: any member of the tenant (mirrors service_weeks_select_tenant;
-- guest-level scoping to invited weeks, if needed, is Phase 2 with the rest
-- of chat).
create policy chat_rooms_select_tenant
  on public.chat_rooms for select to authenticated
  using (church_group_id = public.auth_church_group_id());

-- INSERT: only set_leader/admin, matching who can create the service week
-- this placeholder is attached to.
create policy chat_rooms_insert_leader_admin
  on public.chat_rooms for insert to authenticated
  with check (church_group_id = public.auth_church_group_id() and public.auth_is_leader_or_admin());

-- UPDATE/DELETE: no policy yet — activation (#Phase 2) will add these.

-- ============ DOWN ============
-- drop policy if exists chat_rooms_insert_leader_admin on public.chat_rooms;
-- drop policy if exists chat_rooms_select_tenant on public.chat_rooms;
-- alter table public.chat_rooms disable row level security;
-- drop table if exists chat_rooms;
