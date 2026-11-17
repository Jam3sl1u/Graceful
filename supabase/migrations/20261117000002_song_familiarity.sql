-- Migration: song_familiarity + RLS
-- Issue #221 (Phase 2 / Sprint 6, P2-14). PRD v10 §13.4 "Song familiarity".
--
-- A member marks each song in the group's catalog as comfortable, learning or
-- not yet learned. Decision D7:
--   * every non-guest member reads and writes only their own rows;
--   * set leaders and admins can additionally read the whole group's rows
--     (the input for Phase 4 scheduling) but cannot write other people's;
--   * guests have no access (they cannot read the song catalog either).
--
-- Applying this migration to staging/production is a human step.

-- ============ UP ============

CREATE TYPE public.song_familiarity_level AS ENUM ('comfortable', 'learning', 'not_learned');

CREATE TABLE public.song_familiarity (
  id              uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  song_id         uuid not null references songs(id) on delete cascade,
  level           public.song_familiarity_level not null,
  updated_at      timestamptz not null default now(),
  unique (user_id, song_id)
);

CREATE INDEX idx_song_familiarity_church_group_id_song_id
  ON public.song_familiarity (church_group_id, song_id);

ALTER TABLE public.song_familiarity ENABLE ROW LEVEL SECURITY;

CREATE POLICY song_familiarity_select_own
  ON public.song_familiarity FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND user_id = public.auth_user_id()
  );

CREATE POLICY song_familiarity_select_leader_admin
  ON public.song_familiarity FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.auth_is_leader_or_admin()
  );

-- The song must belong to the caller's own church group.
CREATE POLICY song_familiarity_insert_own
  ON public.song_familiarity FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
    AND public.auth_user_role() IN ('admin', 'set_leader', 'member')
    AND EXISTS (
      SELECT 1 FROM public.songs s
      WHERE s.id = song_id
        AND s.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY song_familiarity_update_own
  ON public.song_familiarity FOR UPDATE TO authenticated
  USING (
    user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
  )
  WITH CHECK (
    user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
    AND public.auth_user_role() IN ('admin', 'set_leader', 'member')
    AND EXISTS (
      SELECT 1 FROM public.songs s
      WHERE s.id = song_id
        AND s.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY song_familiarity_delete_own
  ON public.song_familiarity FOR DELETE TO authenticated
  USING (
    user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
  );

-- ============ DOWN ============
-- DROP POLICY IF EXISTS song_familiarity_delete_own ON public.song_familiarity;
-- DROP POLICY IF EXISTS song_familiarity_update_own ON public.song_familiarity;
-- DROP POLICY IF EXISTS song_familiarity_insert_own ON public.song_familiarity;
-- DROP POLICY IF EXISTS song_familiarity_select_leader_admin ON public.song_familiarity;
-- DROP POLICY IF EXISTS song_familiarity_select_own ON public.song_familiarity;
-- DROP INDEX IF EXISTS public.idx_song_familiarity_church_group_id_song_id;
-- DROP TABLE IF EXISTS public.song_familiarity;
-- DROP TYPE IF EXISTS public.song_familiarity_level;
