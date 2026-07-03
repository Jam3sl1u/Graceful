-- Migration: Cluster 5 (partial) — availability, notification_preferences, notifications
-- Issue #20: [Sprint 0] Migrate schema — Cluster 5 partial
--
-- Scope: availability, notification_preferences, notifications tables and the
-- enums they require (chat_pref, notification_type). Phase 2 objects
-- (chat_rooms, chat_messages, chat_mentions) are explicitly out of scope.
--
-- Depends on: church_groups(id), users(id) — created by issue #16 (Cluster 1).
-- This migration does not create those tables and will fail to apply until
-- issue #16's migration has been applied first. That ordering is expected.

-- migrate:up

-- ==== Enums ====

DO $$ BEGIN
  CREATE TYPE chat_pref AS ENUM ('all', 'mentions');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM (
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
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ==== Tables ====

CREATE TABLE availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  church_group_id uuid NOT NULL REFERENCES church_groups(id) ON DELETE CASCADE,
  date date NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);

CREATE INDEX idx_availability_church_group_id_date
  ON availability (church_group_id, date);

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  invitation_sms boolean NOT NULL DEFAULT true,
  invitation_email boolean NOT NULL DEFAULT true,
  invitation_inapp boolean NOT NULL DEFAULT true,
  reminder_sms boolean NOT NULL DEFAULT true,
  reminder_email boolean NOT NULL DEFAULT false,
  reminder_hours_before integer NOT NULL DEFAULT 24,
  setlist_sms boolean NOT NULL DEFAULT true,
  setlist_email boolean NOT NULL DEFAULT true,
  chat_preference chat_pref NOT NULL DEFAULT 'mentions',
  gcal_sync_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_group_id uuid NOT NULL REFERENCES church_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  title varchar(200) NOT NULL,
  body text,
  link_entity_type varchar(50),
  link_entity_id uuid,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_id_is_read
  ON notifications (user_id, is_read);

CREATE INDEX idx_notifications_user_id_created_at
  ON notifications (user_id, created_at DESC);

-- migrate:down

DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS availability;
DROP TYPE IF EXISTS notification_type;
DROP TYPE IF EXISTS chat_pref;
