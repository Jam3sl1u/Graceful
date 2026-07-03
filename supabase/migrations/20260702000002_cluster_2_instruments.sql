-- Cluster 2 — Instruments
-- Issue #17: [Sprint 0] Migrate schema — Cluster 2 (Instruments)
--
-- Depends on Cluster 1 (church_groups, users, member_profiles), introduced in
-- 20260702000001_cluster_1_organization.sql. This migration is timestamped
-- to apply after Cluster 1's migration so FK references resolve correctly.

create table instruments (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  name varchar(100) not null,
  is_default boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_instruments_church_group_id on instruments (church_group_id);

create table member_instruments (
  id uuid primary key default gen_random_uuid(),
  member_profile_id uuid not null references member_profiles(id) on delete cascade,
  instrument_id uuid not null references instruments(id) on delete cascade,
  unique (member_profile_id, instrument_id)
);

-- ============ DOWN ============
-- drop table if exists member_instruments;
-- drop table if exists instruments;
