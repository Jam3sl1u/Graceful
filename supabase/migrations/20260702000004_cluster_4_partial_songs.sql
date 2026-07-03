-- Cluster 4 — Music & Files (partial)
-- Issue #19: [Sprint 0] Migrate schema — Cluster 4 partial (songs, song_documents)
--
-- Depends on Cluster 1 (church_groups, users), introduced in
-- 20260702000001_cluster_1_organization.sql. This migration is timestamped
-- to apply after Cluster 3's migration so FK references resolve correctly.
--
-- This is an intentional partial slice of PRD §20.6 (Cluster 4 — Music &
-- Files): only `songs` and `song_documents` are created here. `documents`
-- (general shared library, Phase 2) and `transcription_jobs` (Phase 3, also
-- depends on enums job_status/audio_source not created anywhere yet) are
-- explicitly out of scope for this issue.
--
-- `default_key` validation (BR-09, "must be a valid musical key") is
-- explicitly application-layer per the issue's own acceptance criteria — no
-- DB check constraint enumerating valid keys is added here.
--
-- Bonus unblock, not in scope: creating `songs` here means the
-- `setlist_songs.song_id` column added by Cluster 3's migration
-- (20260702000003_cluster_3_scheduling_core.sql) could now get its deferred
-- FK constraint added. That is intentionally NOT done in this migration —
-- it would mean touching a different cluster's already-shipped migration
-- file, which is out of scope for this issue.

create table songs (
  id uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  title varchar(200) not null,
  artist varchar(200),
  default_key varchar(5),
  bpm integer,
  tags varchar[],
  spotify_id varchar(50),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table song_documents (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  -- Denormalized church_group_id (not derived via song_id) for RLS query
  -- efficiency, per the issue's own acceptance criteria.
  church_group_id uuid not null references church_groups(id) on delete cascade,
  name varchar(200) not null,
  file_key text not null,
  file_type varchar(50) not null,
  file_size_bytes integer not null,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_song_documents_church_group_id on song_documents (church_group_id);

-- ============ DOWN ============
-- drop table if exists song_documents;
-- drop table if exists songs;
