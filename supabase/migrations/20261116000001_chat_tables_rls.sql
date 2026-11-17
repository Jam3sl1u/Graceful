-- Migration: Chat tables + RLS — Issue #208 (Phase 2 / Sprint 5, P2-01)
-- PRD v10 §15.1, §20.7, §22.11, §25.1.
--
-- Adds the per-service-week chat schema: chat_rooms, chat_messages,
-- chat_mentions, the chat_message_kind enum, and the is_chat_room_member()
-- helper used by every chat policy.
--
-- Membership rule (D2): a user is a member of a week's chat room iff the room
-- is in the caller's church group AND either
--   (a) the caller's role is admin or set_leader, or
--   (b) the caller has an invitations row for the room's service_week_id with
--       status = 'accepted' (members and guests alike).
-- Pending, denied and withdrawn invitees are not members.
--
-- Depends on clusters 1, 3 and 5 (users, service_weeks, invitations) and on
-- 20260704000001_rls_policies.sql (auth_* helper functions).
--
-- Applying this migration to staging/production is a human step.

-- ============ UP ============

CREATE TYPE public.chat_message_kind AS ENUM ('text', 'devotion');

CREATE TABLE public.chat_rooms (
  id              uuid primary key default gen_random_uuid(),
  church_group_id uuid not null references church_groups(id) on delete cascade,
  service_week_id uuid not null unique references service_weeks(id) on delete cascade,
  is_archived     boolean not null default false,
  pinned_message_id uuid,
  created_at      timestamptz not null default now()
);

CREATE TABLE public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  chat_room_id    uuid not null references chat_rooms(id) on delete cascade,
  church_group_id uuid not null references church_groups(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  content         text not null,
  kind            public.chat_message_kind not null default 'text',
  metadata        jsonb,
  is_deleted      boolean not null default false,
  created_at      timestamptz not null default now(),
  CONSTRAINT chat_messages_content_length_check CHECK (char_length(content) <= 2000)
);

-- Circular reference: added once both tables exist.
ALTER TABLE public.chat_rooms
  ADD CONSTRAINT chat_rooms_pinned_message_id_fkey
  FOREIGN KEY (pinned_message_id) REFERENCES public.chat_messages(id) ON DELETE SET NULL;

CREATE TABLE public.chat_mentions (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references chat_messages(id) on delete cascade,
  mentioned_user_id uuid not null references users(id) on delete cascade,
  unique (message_id, mentioned_user_id)
);

CREATE INDEX idx_chat_messages_chat_room_id_created_at
  ON public.chat_messages (chat_room_id, created_at desc);
CREATE INDEX idx_chat_mentions_mentioned_user_id
  ON public.chat_mentions (mentioned_user_id);

-- is_chat_room_member(): D2 membership rule (see header). SECURITY DEFINER
-- because it reads chat_rooms and invitations from inside chat_rooms' own
-- policy; under invoker rights that recurses or is filtered by
-- invitations_select_own. Never returns NULL.
CREATE OR REPLACE FUNCTION public.is_chat_room_member(p_chat_room_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT EXISTS (
        SELECT 1
        FROM public.chat_rooms r
        WHERE r.id = p_chat_room_id
          AND r.church_group_id = public.auth_church_group_id()
          AND (
            public.auth_is_leader_or_admin()
            OR EXISTS (
              SELECT 1
              FROM public.invitations i
              WHERE i.service_week_id = r.service_week_id
                AND i.church_group_id = r.church_group_id
                AND i.user_id = public.auth_user_id()
                AND i.status = 'accepted'
            )
          )
      )
    ),
    false
  )
$$;

ALTER TABLE public.chat_rooms    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_mentions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- chat_rooms
-- ---------------------------------------------------------------------------

-- Archived rooms stay readable.
CREATE POLICY chat_rooms_select_member
  ON public.chat_rooms FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.is_chat_room_member(id)
  );

CREATE POLICY chat_rooms_insert_leader_admin
  ON public.chat_rooms FOR INSERT TO authenticated
  WITH CHECK (
    church_group_id = public.auth_church_group_id()
    AND public.auth_is_leader_or_admin()
    AND EXISTS (
      SELECT 1 FROM public.service_weeks sw
      WHERE sw.id = service_week_id
        AND sw.church_group_id = public.auth_church_group_id()
    )
  );

-- The pinned message must belong to this same room.
CREATE POLICY chat_rooms_update_leader_admin
  ON public.chat_rooms FOR UPDATE TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.auth_is_leader_or_admin()
  )
  WITH CHECK (
    church_group_id = public.auth_church_group_id()
    AND public.auth_is_leader_or_admin()
    AND EXISTS (
      SELECT 1 FROM public.service_weeks sw
      WHERE sw.id = service_week_id
        AND sw.church_group_id = public.auth_church_group_id()
    )
    AND (
      pinned_message_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.chat_messages m
        WHERE m.id = pinned_message_id
          AND m.chat_room_id = chat_rooms.id
      )
    )
  );

-- No DELETE policy: rooms disappear only by FK cascade from service_weeks /
-- church_groups (RI cascades bypass RLS).

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------

CREATE POLICY chat_messages_select_member
  ON public.chat_messages FOR SELECT TO authenticated
  USING (
    church_group_id = public.auth_church_group_id()
    AND public.is_chat_room_member(chat_room_id)
  );

-- Archived rooms are readable, not writable.
CREATE POLICY chat_messages_insert_member
  ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
    AND public.is_chat_room_member(chat_room_id)
    AND EXISTS (
      SELECT 1 FROM public.chat_rooms r
      WHERE r.id = chat_room_id
        AND r.church_group_id = chat_messages.church_group_id
        AND r.is_archived = false
    )
  );

-- Author-only UPDATE: the soft-delete path, and nothing else. PRD §20.7 is
-- "soft-delete only", so authenticated callers may write a single column
-- (is_deleted) and the policy's WITH CHECK only accepts is_deleted = true:
-- content, kind, metadata, created_at, user_id and chat_room_id cannot be
-- rewritten, and a message cannot be un-deleted or moved to another room.
-- Column privileges, same idea as the audit_logs REVOKE in cluster 6.
REVOKE UPDATE ON public.chat_messages FROM authenticated, anon;
GRANT UPDATE (is_deleted) ON public.chat_messages TO authenticated;

CREATE POLICY chat_messages_update_own
  ON public.chat_messages FOR UPDATE TO authenticated
  USING (
    user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
    AND public.is_chat_room_member(chat_room_id)
    AND EXISTS (
      SELECT 1 FROM public.chat_rooms r
      WHERE r.id = chat_room_id
        AND r.church_group_id = chat_messages.church_group_id
        AND r.is_archived = false
    )
  )
  WITH CHECK (
    is_deleted = true
    AND user_id = public.auth_user_id()
    AND church_group_id = public.auth_church_group_id()
    AND public.is_chat_room_member(chat_room_id)
    AND EXISTS (
      SELECT 1 FROM public.chat_rooms r
      WHERE r.id = chat_room_id
        AND r.church_group_id = chat_messages.church_group_id
        AND r.is_archived = false
    )
  );

-- No DELETE policy: messages are soft-deleted only (is_deleted).

-- ---------------------------------------------------------------------------
-- chat_mentions (scoped through the parent message)
-- ---------------------------------------------------------------------------

CREATE POLICY chat_mentions_select_member
  ON public.chat_mentions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_messages m
      WHERE m.id = chat_mentions.message_id
        AND m.church_group_id = public.auth_church_group_id()
        AND public.is_chat_room_member(m.chat_room_id)
    )
  );

CREATE POLICY chat_mentions_insert_author
  ON public.chat_mentions FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.chat_messages m
      JOIN public.chat_rooms r ON r.id = m.chat_room_id
      WHERE m.id = message_id
        AND m.user_id = public.auth_user_id()
        AND m.church_group_id = public.auth_church_group_id()
        AND r.is_archived = false
        AND public.is_chat_room_member(m.chat_room_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = mentioned_user_id
        AND u.church_group_id = public.auth_church_group_id()
    )
  );

-- No UPDATE or DELETE policy on chat_mentions.

-- ============ DOWN ============
-- DROP POLICY IF EXISTS chat_mentions_insert_author ON public.chat_mentions;
-- DROP POLICY IF EXISTS chat_mentions_select_member ON public.chat_mentions;
-- DROP POLICY IF EXISTS chat_messages_update_own ON public.chat_messages;
-- DROP POLICY IF EXISTS chat_messages_insert_member ON public.chat_messages;
-- DROP POLICY IF EXISTS chat_messages_select_member ON public.chat_messages;
-- DROP POLICY IF EXISTS chat_rooms_update_leader_admin ON public.chat_rooms;
-- DROP POLICY IF EXISTS chat_rooms_insert_leader_admin ON public.chat_rooms;
-- DROP POLICY IF EXISTS chat_rooms_select_member ON public.chat_rooms;
-- DROP FUNCTION IF EXISTS public.is_chat_room_member(uuid);
-- DROP INDEX IF EXISTS public.idx_chat_mentions_mentioned_user_id;
-- DROP INDEX IF EXISTS public.idx_chat_messages_chat_room_id_created_at;
-- DROP TABLE IF EXISTS public.chat_mentions;
-- ALTER TABLE public.chat_rooms DROP CONSTRAINT IF EXISTS chat_rooms_pinned_message_id_fkey;
-- DROP TABLE IF EXISTS public.chat_messages;
-- DROP TABLE IF EXISTS public.chat_rooms;
-- DROP TYPE IF EXISTS public.chat_message_kind;
