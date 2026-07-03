-- Migration: RLS Policies — Issue #22
-- Adds reusable JWT helper functions and church_group_id-scoped RLS policies
-- on all 18 Phase 1 tables. church_groups is intentionally excluded (no
-- church_group_id column; #23 tracks follow-up).
--
-- Supersedes the bootstrap slice in 20260703000001_users_self_read_rls.sql:
-- drops users_select_own and replaces it with full group-scoped users policies.

-- ============ UP ============

-- ---------------------------------------------------------------------------
-- Helper functions (public schema, SECURITY DEFINER to bypass RLS on users
-- when resolving identity — prevents circular policy evaluation)
-- ---------------------------------------------------------------------------

-- auth_user_id(): internal users.id for the authenticated Clerk sub.
CREATE OR REPLACE FUNCTION public.auth_user_id()
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT id
  FROM public.users
  WHERE clerk_id = (auth.jwt() ->> 'sub')
$$;

-- auth_church_group_id(): JWT claim first (fast path); DB fallback until
-- Clerk custom claim sync (#5/#6) lands.
CREATE OR REPLACE FUNCTION public.auth_church_group_id()
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT COALESCE(
    (auth.jwt() ->> 'church_group_id')::uuid,
    (SELECT church_group_id FROM public.users WHERE clerk_id = (auth.jwt() ->> 'sub'))
  )
$$;

-- auth_user_role(): JWT claim first; DB fallback. Guards against non-enum
-- values (e.g. Supabase's built-in 'authenticated' role) via CASE.
CREATE OR REPLACE FUNCTION public.auth_user_role()
  RETURNS public.user_role
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT COALESCE(
    CASE WHEN (auth.jwt() ->> 'role') IN ('admin', 'set_leader', 'member', 'guest')
         THEN (auth.jwt() ->> 'role')::public.user_role
    END,
    (SELECT role FROM public.users WHERE clerk_id = (auth.jwt() ->> 'sub'))
  )
$$;

-- auth_is_leader_or_admin(): true for set_leader and admin roles.
CREATE OR REPLACE FUNCTION public.auth_is_leader_or_admin()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT public.auth_user_role() IN ('admin', 'set_leader')
$$;

-- ---------------------------------------------------------------------------
-- users — replace bootstrap slice with full group-scoped policies
-- (RLS was already enabled by 20260703000001; no ALTER needed)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS users_select_own ON public.users;

-- SELECT: full member directory within same church group
CREATE POLICY users_select_tenant
  ON public.users FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

-- INSERT: provisioning is service-role / webhook only; no policy → deny
-- by RLS default for authenticated role.

-- UPDATE: members update own row; leader/admin update any same-group row
CREATE POLICY users_update_own
  ON public.users FOR UPDATE TO authenticated
  USING  (id = public.auth_user_id())
  WITH CHECK (id = public.auth_user_id());

CREATE POLICY users_update_leader_admin
  ON public.users FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin())
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- DELETE: leader/admin only within same group
CREATE POLICY users_delete_leader_admin
  ON public.users FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- ---------------------------------------------------------------------------
-- Enable RLS on remaining 17 tables
-- ---------------------------------------------------------------------------

ALTER TABLE public.instruments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_instruments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_weeks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.setlists                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.setlist_songs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_attendees          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conflicts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.songs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.song_documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_calendar_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs               ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Tier 1: instruments
-- ---------------------------------------------------------------------------

CREATE POLICY instruments_select_tenant
  ON public.instruments FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

CREATE POLICY instruments_insert_tenant
  ON public.instruments FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY instruments_update_tenant
  ON public.instruments FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id())
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY instruments_delete_tenant
  ON public.instruments FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id());

-- ---------------------------------------------------------------------------
-- Tier 1: service_weeks
-- ---------------------------------------------------------------------------

CREATE POLICY service_weeks_select_tenant
  ON public.service_weeks FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

CREATE POLICY service_weeks_insert_tenant
  ON public.service_weeks FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY service_weeks_update_tenant
  ON public.service_weeks FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id())
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY service_weeks_delete_tenant
  ON public.service_weeks FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id());

-- ---------------------------------------------------------------------------
-- Tier 1: setlists — members/guests see published only; leaders/admins all
-- ---------------------------------------------------------------------------

CREATE POLICY setlists_select_published_members
  ON public.setlists FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND (status = 'published' OR public.auth_is_leader_or_admin())
  );

CREATE POLICY setlists_insert_leader_admin
  ON public.setlists FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY setlists_update_leader_admin
  ON public.setlists FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin())
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY setlists_delete_leader_admin
  ON public.setlists FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- ---------------------------------------------------------------------------
-- Tier 2: setlist_songs — inherits setlist published/draft visibility
-- ---------------------------------------------------------------------------

CREATE POLICY setlist_songs_select_published_members
  ON public.setlist_songs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.setlists s
      WHERE s.id = setlist_songs.setlist_id
        AND s.church_group_id = public.auth_church_group_id()
        AND (s.status = 'published' OR public.auth_is_leader_or_admin())
    )
  );

CREATE POLICY setlist_songs_insert_leader_admin
  ON public.setlist_songs FOR INSERT TO authenticated
  WITH CHECK (
    public.auth_is_leader_or_admin()
    AND EXISTS (
      SELECT 1 FROM public.setlists s
      WHERE s.id = setlist_id
        AND s.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY setlist_songs_update_leader_admin
  ON public.setlist_songs FOR UPDATE TO authenticated
  USING (
    public.auth_is_leader_or_admin()
    AND EXISTS (
      SELECT 1 FROM public.setlists s
      WHERE s.id = setlist_songs.setlist_id
        AND s.church_group_id = public.auth_church_group_id()
    )
  )
  WITH CHECK (
    public.auth_is_leader_or_admin()
    AND EXISTS (
      SELECT 1 FROM public.setlists s
      WHERE s.id = setlist_songs.setlist_id
        AND s.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY setlist_songs_delete_leader_admin
  ON public.setlist_songs FOR DELETE TO authenticated
  USING (
    public.auth_is_leader_or_admin()
    AND EXISTS (
      SELECT 1 FROM public.setlists s
      WHERE s.id = setlist_songs.setlist_id
        AND s.church_group_id = public.auth_church_group_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Tier 1: events
-- ---------------------------------------------------------------------------

CREATE POLICY events_select_tenant
  ON public.events FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

CREATE POLICY events_insert_tenant
  ON public.events FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY events_update_tenant
  ON public.events FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id())
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY events_delete_tenant
  ON public.events FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id());

-- ---------------------------------------------------------------------------
-- Tier 4: invitations — role-gated
-- ---------------------------------------------------------------------------

-- Leaders/admins see all invitations in their group; members see only their own
CREATE POLICY invitations_select_leader_admin
  ON public.invitations FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY invitations_select_own
  ON public.invitations FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND user_id = public.auth_user_id());

-- Only leaders/admins can create invitations
CREATE POLICY invitations_insert_leader_admin
  ON public.invitations FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- Leaders/admins update any row; members can update own row (accept/deny)
CREATE POLICY invitations_update_leader_admin
  ON public.invitations FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin())
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY invitations_update_own
  ON public.invitations FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id() AND user_id = public.auth_user_id())
  WITH CHECK (church_group_id = public.auth_church_group_id() AND user_id = public.auth_user_id());

-- Only leaders/admins can withdraw/delete invitations
CREATE POLICY invitations_delete_leader_admin
  ON public.invitations FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- ---------------------------------------------------------------------------
-- Tier 2: event_attendees — scoped via parent events
-- ---------------------------------------------------------------------------

CREATE POLICY event_attendees_select_tenant
  ON public.event_attendees FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_attendees.event_id
        AND e.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY event_attendees_insert_tenant
  ON public.event_attendees FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_id
        AND e.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY event_attendees_update_tenant
  ON public.event_attendees FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_attendees.event_id
        AND e.church_group_id = public.auth_church_group_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_attendees.event_id
        AND e.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY event_attendees_delete_tenant
  ON public.event_attendees FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_attendees.event_id
        AND e.church_group_id = public.auth_church_group_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Tier 4: conflicts — leader/admin only
-- ---------------------------------------------------------------------------

CREATE POLICY conflicts_select_leader_admin
  ON public.conflicts FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY conflicts_insert_leader_admin
  ON public.conflicts FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY conflicts_update_leader_admin
  ON public.conflicts FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin())
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

CREATE POLICY conflicts_delete_leader_admin
  ON public.conflicts FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- ---------------------------------------------------------------------------
-- Tier 1: songs
-- ---------------------------------------------------------------------------

CREATE POLICY songs_select_tenant
  ON public.songs FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

CREATE POLICY songs_insert_tenant
  ON public.songs FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY songs_update_tenant
  ON public.songs FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id())
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY songs_delete_tenant
  ON public.songs FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id());

-- ---------------------------------------------------------------------------
-- Tier 1: song_documents (direct church_group_id column)
-- ---------------------------------------------------------------------------

CREATE POLICY song_documents_select_tenant
  ON public.song_documents FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

CREATE POLICY song_documents_insert_tenant
  ON public.song_documents FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY song_documents_update_tenant
  ON public.song_documents FOR UPDATE TO authenticated
  USING  (church_group_id = public.auth_church_group_id())
  WITH CHECK (church_group_id = public.auth_church_group_id());

CREATE POLICY song_documents_delete_tenant
  ON public.song_documents FOR DELETE TO authenticated
  USING (church_group_id = public.auth_church_group_id());

-- ---------------------------------------------------------------------------
-- Tier 1: availability — members write own rows; leader/admin any in group
-- ---------------------------------------------------------------------------

CREATE POLICY availability_select_tenant
  ON public.availability FOR SELECT TO authenticated
  USING (church_group_id = public.auth_church_group_id());

CREATE POLICY availability_insert_own
  ON public.availability FOR INSERT TO authenticated
  WITH CHECK (
    church_group_id = public.auth_church_group_id()
    AND (user_id = public.auth_user_id() OR public.auth_is_leader_or_admin())
  );

CREATE POLICY availability_update_own
  ON public.availability FOR UPDATE TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND (user_id = public.auth_user_id() OR public.auth_is_leader_or_admin())
  )
  WITH CHECK (
    church_group_id = public.auth_church_group_id()
    AND (user_id = public.auth_user_id() OR public.auth_is_leader_or_admin())
  );

CREATE POLICY availability_delete_own
  ON public.availability FOR DELETE TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND (user_id = public.auth_user_id() OR public.auth_is_leader_or_admin())
  );

-- ---------------------------------------------------------------------------
-- Tier 1: notifications — tenant + own user_id for SELECT/UPDATE
-- ---------------------------------------------------------------------------

-- Users see only their own notifications within their group
CREATE POLICY notifications_select_own
  ON public.notifications FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND user_id = public.auth_user_id()
  );

-- Leader/admin can dispatch notifications; background jobs use service role
CREATE POLICY notifications_insert_leader_admin
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (church_group_id = public.auth_church_group_id() AND public.auth_is_leader_or_admin());

-- Users can mark their own notifications as read
CREATE POLICY notifications_update_own
  ON public.notifications FOR UPDATE TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND user_id = public.auth_user_id()
  )
  WITH CHECK (
    church_group_id = public.auth_church_group_id()
    AND user_id = public.auth_user_id()
  );

-- ---------------------------------------------------------------------------
-- Tier 3: notification_preferences — user-scoped
-- ---------------------------------------------------------------------------

CREATE POLICY notification_preferences_select_own
  ON public.notification_preferences FOR SELECT TO authenticated
  USING (user_id = public.auth_user_id());

CREATE POLICY notification_preferences_insert_own
  ON public.notification_preferences FOR INSERT TO authenticated
  WITH CHECK (user_id = public.auth_user_id());

CREATE POLICY notification_preferences_update_own
  ON public.notification_preferences FOR UPDATE TO authenticated
  USING  (user_id = public.auth_user_id())
  WITH CHECK (user_id = public.auth_user_id());

CREATE POLICY notification_preferences_delete_own
  ON public.notification_preferences FOR DELETE TO authenticated
  USING (user_id = public.auth_user_id());

-- ---------------------------------------------------------------------------
-- Tier 2: member_profiles — scoped via parent users
-- ---------------------------------------------------------------------------

CREATE POLICY member_profiles_select_tenant
  ON public.member_profiles FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = member_profiles.user_id
        AND u.church_group_id = public.auth_church_group_id()
    )
  );

-- Members insert/update/delete their own profile; leader/admin any in group
CREATE POLICY member_profiles_insert_own
  ON public.member_profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.auth_user_id()
    OR (
      public.auth_is_leader_or_admin()
      AND EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = user_id
          AND u.church_group_id = public.auth_church_group_id()
      )
    )
  );

CREATE POLICY member_profiles_update_own
  ON public.member_profiles FOR UPDATE TO authenticated
  USING (
    user_id = public.auth_user_id()
    OR (
      public.auth_is_leader_or_admin()
      AND EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = member_profiles.user_id
          AND u.church_group_id = public.auth_church_group_id()
      )
    )
  )
  WITH CHECK (
    user_id = public.auth_user_id()
    OR (
      public.auth_is_leader_or_admin()
      AND EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = member_profiles.user_id
          AND u.church_group_id = public.auth_church_group_id()
      )
    )
  );

CREATE POLICY member_profiles_delete_own
  ON public.member_profiles FOR DELETE TO authenticated
  USING (
    user_id = public.auth_user_id()
    OR (
      public.auth_is_leader_or_admin()
      AND EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = member_profiles.user_id
          AND u.church_group_id = public.auth_church_group_id()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Tier 2: member_instruments — scoped via member_profiles → users
-- ---------------------------------------------------------------------------

CREATE POLICY member_instruments_select_tenant
  ON public.member_instruments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.member_profiles mp
      JOIN public.users u ON u.id = mp.user_id
      WHERE mp.id = member_instruments.member_profile_id
        AND u.church_group_id = public.auth_church_group_id()
    )
  );

CREATE POLICY member_instruments_insert_own
  ON public.member_instruments FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.member_profiles mp
      JOIN public.users u ON u.id = mp.user_id
      WHERE mp.id = member_profile_id
        AND u.church_group_id = public.auth_church_group_id()
        AND (u.id = public.auth_user_id() OR public.auth_is_leader_or_admin())
    )
  );

CREATE POLICY member_instruments_update_own
  ON public.member_instruments FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.member_profiles mp
      JOIN public.users u ON u.id = mp.user_id
      WHERE mp.id = member_instruments.member_profile_id
        AND u.church_group_id = public.auth_church_group_id()
        AND (u.id = public.auth_user_id() OR public.auth_is_leader_or_admin())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.member_profiles mp
      JOIN public.users u ON u.id = mp.user_id
      WHERE mp.id = member_instruments.member_profile_id
        AND u.church_group_id = public.auth_church_group_id()
        AND (u.id = public.auth_user_id() OR public.auth_is_leader_or_admin())
    )
  );

CREATE POLICY member_instruments_delete_own
  ON public.member_instruments FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.member_profiles mp
      JOIN public.users u ON u.id = mp.user_id
      WHERE mp.id = member_instruments.member_profile_id
        AND u.church_group_id = public.auth_church_group_id()
        AND (u.id = public.auth_user_id() OR public.auth_is_leader_or_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- Tier 3: google_calendar_tokens — user-scoped
-- ---------------------------------------------------------------------------

CREATE POLICY google_calendar_tokens_select_own
  ON public.google_calendar_tokens FOR SELECT TO authenticated
  USING (user_id = public.auth_user_id());

CREATE POLICY google_calendar_tokens_insert_own
  ON public.google_calendar_tokens FOR INSERT TO authenticated
  WITH CHECK (user_id = public.auth_user_id());

CREATE POLICY google_calendar_tokens_update_own
  ON public.google_calendar_tokens FOR UPDATE TO authenticated
  USING  (user_id = public.auth_user_id())
  WITH CHECK (user_id = public.auth_user_id());

CREATE POLICY google_calendar_tokens_delete_own
  ON public.google_calendar_tokens FOR DELETE TO authenticated
  USING (user_id = public.auth_user_id());

-- ---------------------------------------------------------------------------
-- Tier 4: audit_logs — admin SELECT only
-- INSERT via service role / triggers only (no authenticated INSERT policy);
-- UPDATE and DELETE already REVOKEd from cluster 6 migration.
-- ---------------------------------------------------------------------------

CREATE POLICY audit_logs_select_admin
  ON public.audit_logs FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.auth_user_role() = 'admin'
  );

-- ============ DOWN ============
-- Run in reverse dependency order to restore the bootstrap slice.
-- (commented; uncomment and execute to reverse)

-- -- audit_logs
-- DROP POLICY IF EXISTS audit_logs_select_admin ON public.audit_logs;
-- ALTER TABLE public.audit_logs DISABLE ROW LEVEL SECURITY;

-- -- google_calendar_tokens
-- DROP POLICY IF EXISTS google_calendar_tokens_delete_own ON public.google_calendar_tokens;
-- DROP POLICY IF EXISTS google_calendar_tokens_update_own ON public.google_calendar_tokens;
-- DROP POLICY IF EXISTS google_calendar_tokens_insert_own ON public.google_calendar_tokens;
-- DROP POLICY IF EXISTS google_calendar_tokens_select_own ON public.google_calendar_tokens;
-- ALTER TABLE public.google_calendar_tokens DISABLE ROW LEVEL SECURITY;

-- -- member_instruments
-- DROP POLICY IF EXISTS member_instruments_delete_own ON public.member_instruments;
-- DROP POLICY IF EXISTS member_instruments_update_own ON public.member_instruments;
-- DROP POLICY IF EXISTS member_instruments_insert_own ON public.member_instruments;
-- DROP POLICY IF EXISTS member_instruments_select_tenant ON public.member_instruments;
-- ALTER TABLE public.member_instruments DISABLE ROW LEVEL SECURITY;

-- -- member_profiles
-- DROP POLICY IF EXISTS member_profiles_delete_own ON public.member_profiles;
-- DROP POLICY IF EXISTS member_profiles_update_own ON public.member_profiles;
-- DROP POLICY IF EXISTS member_profiles_insert_own ON public.member_profiles;
-- DROP POLICY IF EXISTS member_profiles_select_tenant ON public.member_profiles;
-- ALTER TABLE public.member_profiles DISABLE ROW LEVEL SECURITY;

-- -- notification_preferences
-- DROP POLICY IF EXISTS notification_preferences_delete_own ON public.notification_preferences;
-- DROP POLICY IF EXISTS notification_preferences_update_own ON public.notification_preferences;
-- DROP POLICY IF EXISTS notification_preferences_insert_own ON public.notification_preferences;
-- DROP POLICY IF EXISTS notification_preferences_select_own ON public.notification_preferences;
-- ALTER TABLE public.notification_preferences DISABLE ROW LEVEL SECURITY;

-- -- notifications
-- DROP POLICY IF EXISTS notifications_update_own ON public.notifications;
-- DROP POLICY IF EXISTS notifications_insert_leader_admin ON public.notifications;
-- DROP POLICY IF EXISTS notifications_select_own ON public.notifications;
-- ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY;

-- -- availability
-- DROP POLICY IF EXISTS availability_delete_own ON public.availability;
-- DROP POLICY IF EXISTS availability_update_own ON public.availability;
-- DROP POLICY IF EXISTS availability_insert_own ON public.availability;
-- DROP POLICY IF EXISTS availability_select_tenant ON public.availability;
-- ALTER TABLE public.availability DISABLE ROW LEVEL SECURITY;

-- -- song_documents
-- DROP POLICY IF EXISTS song_documents_delete_tenant ON public.song_documents;
-- DROP POLICY IF EXISTS song_documents_update_tenant ON public.song_documents;
-- DROP POLICY IF EXISTS song_documents_insert_tenant ON public.song_documents;
-- DROP POLICY IF EXISTS song_documents_select_tenant ON public.song_documents;
-- ALTER TABLE public.song_documents DISABLE ROW LEVEL SECURITY;

-- -- songs
-- DROP POLICY IF EXISTS songs_delete_tenant ON public.songs;
-- DROP POLICY IF EXISTS songs_update_tenant ON public.songs;
-- DROP POLICY IF EXISTS songs_insert_tenant ON public.songs;
-- DROP POLICY IF EXISTS songs_select_tenant ON public.songs;
-- ALTER TABLE public.songs DISABLE ROW LEVEL SECURITY;

-- -- conflicts
-- DROP POLICY IF EXISTS conflicts_delete_leader_admin ON public.conflicts;
-- DROP POLICY IF EXISTS conflicts_update_leader_admin ON public.conflicts;
-- DROP POLICY IF EXISTS conflicts_insert_leader_admin ON public.conflicts;
-- DROP POLICY IF EXISTS conflicts_select_leader_admin ON public.conflicts;
-- ALTER TABLE public.conflicts DISABLE ROW LEVEL SECURITY;

-- -- event_attendees
-- DROP POLICY IF EXISTS event_attendees_delete_tenant ON public.event_attendees;
-- DROP POLICY IF EXISTS event_attendees_update_tenant ON public.event_attendees;
-- DROP POLICY IF EXISTS event_attendees_insert_tenant ON public.event_attendees;
-- DROP POLICY IF EXISTS event_attendees_select_tenant ON public.event_attendees;
-- ALTER TABLE public.event_attendees DISABLE ROW LEVEL SECURITY;

-- -- invitations
-- DROP POLICY IF EXISTS invitations_delete_leader_admin ON public.invitations;
-- DROP POLICY IF EXISTS invitations_update_own ON public.invitations;
-- DROP POLICY IF EXISTS invitations_update_leader_admin ON public.invitations;
-- DROP POLICY IF EXISTS invitations_insert_leader_admin ON public.invitations;
-- DROP POLICY IF EXISTS invitations_select_own ON public.invitations;
-- DROP POLICY IF EXISTS invitations_select_leader_admin ON public.invitations;
-- ALTER TABLE public.invitations DISABLE ROW LEVEL SECURITY;

-- -- events
-- DROP POLICY IF EXISTS events_delete_tenant ON public.events;
-- DROP POLICY IF EXISTS events_update_tenant ON public.events;
-- DROP POLICY IF EXISTS events_insert_tenant ON public.events;
-- DROP POLICY IF EXISTS events_select_tenant ON public.events;
-- ALTER TABLE public.events DISABLE ROW LEVEL SECURITY;

-- -- setlist_songs
-- DROP POLICY IF EXISTS setlist_songs_delete_leader_admin ON public.setlist_songs;
-- DROP POLICY IF EXISTS setlist_songs_update_leader_admin ON public.setlist_songs;
-- DROP POLICY IF EXISTS setlist_songs_insert_leader_admin ON public.setlist_songs;
-- DROP POLICY IF EXISTS setlist_songs_select_published_members ON public.setlist_songs;
-- ALTER TABLE public.setlist_songs DISABLE ROW LEVEL SECURITY;

-- -- setlists
-- DROP POLICY IF EXISTS setlists_delete_leader_admin ON public.setlists;
-- DROP POLICY IF EXISTS setlists_update_leader_admin ON public.setlists;
-- DROP POLICY IF EXISTS setlists_insert_leader_admin ON public.setlists;
-- DROP POLICY IF EXISTS setlists_select_published_members ON public.setlists;
-- ALTER TABLE public.setlists DISABLE ROW LEVEL SECURITY;

-- -- service_weeks
-- DROP POLICY IF EXISTS service_weeks_delete_tenant ON public.service_weeks;
-- DROP POLICY IF EXISTS service_weeks_update_tenant ON public.service_weeks;
-- DROP POLICY IF EXISTS service_weeks_insert_tenant ON public.service_weeks;
-- DROP POLICY IF EXISTS service_weeks_select_tenant ON public.service_weeks;
-- ALTER TABLE public.service_weeks DISABLE ROW LEVEL SECURITY;

-- -- instruments
-- DROP POLICY IF EXISTS instruments_delete_tenant ON public.instruments;
-- DROP POLICY IF EXISTS instruments_update_tenant ON public.instruments;
-- DROP POLICY IF EXISTS instruments_insert_tenant ON public.instruments;
-- DROP POLICY IF EXISTS instruments_select_tenant ON public.instruments;
-- ALTER TABLE public.instruments DISABLE ROW LEVEL SECURITY;

-- -- users: restore bootstrap slice
-- DROP POLICY IF EXISTS users_delete_leader_admin ON public.users;
-- DROP POLICY IF EXISTS users_update_leader_admin ON public.users;
-- DROP POLICY IF EXISTS users_update_own ON public.users;
-- DROP POLICY IF EXISTS users_select_tenant ON public.users;
-- CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated
--   USING (clerk_id = (auth.jwt() ->> 'sub'));

-- -- helper functions
-- DROP FUNCTION IF EXISTS public.auth_is_leader_or_admin();
-- DROP FUNCTION IF EXISTS public.auth_user_role();
-- DROP FUNCTION IF EXISTS public.auth_church_group_id();
-- DROP FUNCTION IF EXISTS public.auth_user_id();
