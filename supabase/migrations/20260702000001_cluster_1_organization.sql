-- Migration: Cluster 1 — Organization
-- Tables: church_groups, users, member_profiles
-- Enums: user_role, vocal_capability (vocal_capability is created here and reused by Cluster 5)

-- ============ UP ============
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- enums
create type user_role as enum ('admin', 'set_leader', 'member', 'guest');

-- vocal_capability is created here (Cluster 1) and must NOT be redefined by
-- the later Cluster 5 migration; it is reused by member_profiles there too.
create type vocal_capability as enum ('none', 'lead', 'harmony', 'both');

-- tables in FK dependency order: church_groups -> users -> member_profiles

create table church_groups (
  id uuid primary key default gen_random_uuid(),
  name varchar(100) not null,
  denomination varchar(100),
  timezone varchar(50) not null default 'America/Chicago',
  logo_url text,
  invite_code varchar(20) not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  clerk_id varchar(50) not null unique,
  church_group_id uuid not null references church_groups(id) on delete cascade,
  role user_role not null default 'member',
  name varchar(100) not null,
  email varchar(255) unique,
  phone varchar(20),
  sms_opted_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_users_church_group_id on users (church_group_id);

create table member_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  vocal_capability vocal_capability not null default 'none',
  bio text,
  created_at timestamptz not null default now()
);

-- ============ DOWN ============
-- (commented; run to reverse — drop in reverse dependency order)
-- drop table if exists member_profiles;
-- drop table if exists users;
-- drop table if exists church_groups;
-- drop type if exists vocal_capability;
-- drop type if exists user_role;
