-- Cluster 3 — Scheduling core
-- Issue #18: [Sprint 0] Migrate schema — Cluster 3 (Scheduling core)
--
-- Depends on Cluster 1 (church_groups, users), introduced in
-- 20260702000001_cluster_1_organization.sql. This migration is timestamped
-- to apply after Cluster 1's migration so FK references resolve correctly.
--
-- Note: PRD §20.5 is headed "Cluster 3 — Scheduling Core" but its first
-- table listed is `availability`. Per the PRD's own §20.1 overview table,
-- `availability` actually belongs to Cluster 5 ("Communication & state"),
-- not Cluster 3 — this is a documentation quirk in §20.5. The issue's
-- acceptance criteria list exactly 7 tables and do NOT include
-- `availability`, so it is intentionally not created here.

create type invitation_status as enum ('pending', 'accepted', 'denied', 'withdrawn');
create type event_type as enum ('pre_practice', 'rehearsal', 'sound_check', 'service');
create type resolution_type as enum ('replaced', 'withdrawn', 'member_reconfirmed', 'admin_dismissed');
create type setlist_status as enum ('draft', 'published');

create table service_weeks (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  service_date date not null,
  title varchar(100),
  sermon_topic text,
  sermon_scripture text,
  speaker_name varchar(100),
  notes text,
  is_cancelled boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table setlists (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  service_week_id uuid not null unique references service_weeks(id) on delete cascade,
  status setlist_status not null default 'draft',
  published_at timestamptz,
  notes text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table setlist_songs (
  id uuid primary key default gen_random_uuid(),
  setlist_id uuid not null references setlists(id) on delete cascade,
  -- song_id intentionally has no FK constraint yet: `songs` (Cluster 4) does
  -- not exist until issue #19's migration. Add `alter table setlist_songs
  -- add constraint setlist_songs_song_id_fkey foreign key (song_id)
  -- references songs(id);` in that migration once the table exists.
  song_id uuid not null,
  position integer not null,
  key_override varchar(5),
  notes text,
  unique (setlist_id, song_id)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  service_week_id uuid not null references service_weeks(id) on delete cascade,
  type event_type not null,
  name varchar(100) not null,
  location text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  google_calendar_event_id varchar(100),
  notes text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  service_week_id uuid not null references service_weeks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_note text,
  status invitation_status not null default 'pending',
  response_token varchar(64) not null unique,
  responded_at timestamptz,
  denial_reason text,
  denial_count integer not null default 0,
  response_deadline timestamptz,
  invited_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table event_attendees (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create table conflicts (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  invitation_id uuid not null references invitations(id) on delete cascade,
  triggered_by uuid references users(id) on delete set null,
  trigger_reason text,
  replacement_suggestion_user_id uuid references users(id) on delete set null,
  resolved_at timestamptz,
  resolution_type resolution_type,
  created_at timestamptz not null default now()
);

-- ============ DOWN ============
-- drop table if exists conflicts;
-- drop table if exists event_attendees;
-- drop table if exists invitations;
-- drop table if exists events;
-- drop table if exists setlist_songs;
-- drop table if exists setlists;
-- drop table if exists service_weeks;
-- drop type if exists setlist_status;
-- drop type if exists resolution_type;
-- drop type if exists event_type;
-- drop type if exists invitation_status;
