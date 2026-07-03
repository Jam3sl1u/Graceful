-- Migration: Cluster 5 (partial) — availability, notification_preferences, notifications
-- Issue #20: [Sprint 0] Migrate schema — Cluster 5 partial
--
-- Scope: availability, notification_preferences, notifications tables and the
-- enums they require (chat_pref, notification_type). Phase 2 objects
-- (chat_rooms, chat_messages, chat_mentions) are explicitly out of scope.
--
-- Depends on Cluster 1 (church_groups, users) from
-- 20260702000001_cluster_1_organization.sql. vocal_capability enum is owned by
-- Cluster 1 and must NOT be redefined here.

-- ============ UP ============

create type chat_pref as enum ('all', 'mentions');

create type notification_type as enum (
  'set_invitation',
  'invitation_reminder',
  'invitation_accepted',
  'invitation_denied',
  'practice_reminder',
  'setlist_released',
  'scheduling_conflict',
  'chat_mention',
  'devotion_shared',
  'new_church_document',
  'google_calendar_event'
);

create table availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  church_group_id uuid not null references church_groups(id) on delete cascade,
  date date not null,
  is_available boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create index idx_availability_church_group_id_date
  on availability (church_group_id, date);

create table notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  invitation_sms boolean not null default true,
  invitation_email boolean not null default true,
  invitation_inapp boolean not null default true,
  reminder_sms boolean not null default true,
  reminder_email boolean not null default false,
  reminder_hours_before integer not null default 24,
  setlist_sms boolean not null default true,
  setlist_email boolean not null default true,
  chat_preference chat_pref not null default 'mentions',
  gcal_sync_enabled boolean not null default false
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  type notification_type not null,
  title varchar(200) not null,
  body text,
  link_entity_type varchar(50),
  link_entity_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_notifications_user_id_is_read
  on notifications (user_id, is_read);

create index idx_notifications_user_id_created_at
  on notifications (user_id, created_at desc);

-- ============ DOWN ============
-- (commented; run to reverse — drop in reverse dependency order)
-- drop table if exists notifications;
-- drop table if exists notification_preferences;
-- drop table if exists availability;
-- drop type if exists notification_type;
-- drop type if exists chat_pref;
