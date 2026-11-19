-- Migration: documents (church group general shared library) + RLS
-- Issue #216 (Phase 2 / Sprint 6, P2-09). PRD v10 §11.2, §20.6, §22.9, §25.2.
--
-- The general library is distinct from song_documents (files attached to a
-- song): nothing here references a song or a service week, and
-- song_documents is not changed.
--
-- Access (decision D3):
--   * members, set leaders and admins of the church group can read;
--   * only admins can add or remove;
--   * guests have no access to the general library at all;
--   * rows are immutable once written — there is no UPDATE policy. Replace a
--     document by deleting it and uploading again.
-- file_key is an R2 object key, never a URL (PRD §25.2: signed URLs only).
--
-- Applying this migration to staging/production is a human step.

-- ============ UP ============

CREATE TABLE public.documents (
  id              uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  name            varchar(200) not null,
  file_key        text not null unique,
  file_type       varchar(50) not null,
  file_size_bytes integer not null,
  folder          varchar(100) not null default 'General',
  description     text,
  uploaded_by     uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  CONSTRAINT documents_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT documents_folder_not_blank_check CHECK (btrim(folder) <> ''),
  CONSTRAINT documents_file_size_positive_check CHECK (file_size_bytes > 0)
);

CREATE INDEX idx_documents_church_group_id_folder
  ON public.documents (church_group_id, folder);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select_non_guest
  ON public.documents FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.auth_user_role() IN ('admin', 'set_leader', 'member')
  );

CREATE POLICY documents_insert_admin
  ON public.documents FOR INSERT TO authenticated
  WITH CHECK (
    church_group_id = public.auth_church_group_id()
    AND public.auth_user_role() = 'admin'
    AND uploaded_by = public.auth_user_id()
  );

CREATE POLICY documents_delete_admin
  ON public.documents FOR DELETE TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.auth_user_role() = 'admin'
  );

-- No UPDATE policy: see header.

-- ============ DOWN ============
-- DROP POLICY IF EXISTS documents_delete_admin ON public.documents;
-- DROP POLICY IF EXISTS documents_insert_admin ON public.documents;
-- DROP POLICY IF EXISTS documents_select_non_guest ON public.documents;
-- DROP INDEX IF EXISTS public.idx_documents_church_group_id_folder;
-- DROP TABLE IF EXISTS public.documents;
