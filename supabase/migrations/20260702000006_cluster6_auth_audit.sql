-- Cluster 6 — Auth & Audit (PRD §20.8)
-- Creates google_calendar_tokens and audit_logs.
-- Schema only: no RLS policies (#13), no encryption logic (#61), no seed data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- google_calendar_tokens: one row per user; user_id is a UNIQUE FK (1:1, §20.9).
-- access_token_encrypted / refresh_token_encrypted store AES-256 ciphertext
-- produced by the application layer; the DB just stores text.
CREATE TABLE google_calendar_tokens (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    access_token_encrypted text NOT NULL,
    refresh_token_encrypted text NOT NULL,
    token_expiry timestamptz NOT NULL,
    calendar_id varchar(200) NOT NULL,
    scope text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT google_calendar_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT google_calendar_tokens_user_id_key UNIQUE (user_id),
    CONSTRAINT google_calendar_tokens_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- audit_logs: append-only (BR-13). user_id is nullable for system-triggered
-- actions; ON DELETE SET NULL preserves the immutable row when a user is
-- deleted.
CREATE TABLE audit_logs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    church_group_id uuid NOT NULL,
    user_id uuid NULL,
    action varchar(100) NOT NULL,
    entity_type varchar(50) NOT NULL,
    entity_id uuid NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
    CONSTRAINT audit_logs_church_group_id_fkey
        FOREIGN KEY (church_group_id) REFERENCES church_groups (id) ON DELETE CASCADE,
    CONSTRAINT audit_logs_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

-- Append-only enforcement (BR-13): no application role may UPDATE or DELETE
-- audit rows. INSERT and SELECT remain allowed.
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE UPDATE, DELETE ON TABLE audit_logs FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE UPDATE, DELETE ON TABLE audit_logs FROM anon;
    END IF;
END
$$;

-- Suggested indexes.
CREATE INDEX audit_logs_church_group_id_created_at_idx
    ON audit_logs (church_group_id, created_at DESC);

COMMIT;
