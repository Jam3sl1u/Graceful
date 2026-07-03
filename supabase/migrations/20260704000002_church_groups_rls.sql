-- Migration: church_groups RLS — Sprint 0 review fix
-- Issue #22 scoped to "every Phase 1 table" but church_groups was explicitly
-- excluded because it has no church_group_id column. Issue #23 (PostgREST
-- lockdown) did not fill the gap. This migration closes it.
--
-- Policy: authenticated users can SELECT their own group only. All writes
-- remain service-role-only (no authenticated INSERT/UPDATE/DELETE policy →
-- denied by RLS default).

-- ============ UP ============

ALTER TABLE public.church_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY church_groups_select_own
  ON public.church_groups FOR SELECT TO authenticated
  USING (id = public.auth_church_group_id());

-- ============ DOWN ============
-- DROP POLICY IF EXISTS church_groups_select_own ON public.church_groups;
-- ALTER TABLE public.church_groups DISABLE ROW LEVEL SECURITY;
