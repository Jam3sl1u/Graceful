-- Migration: Invitation withdrawn notification type
-- Issue #43: DELETE /api/invitations/:id (withdraw invitation).
--
-- notification_type (created in 20260702000005_cluster_5_partial.sql) has no
-- value for "your invitation was withdrawn" — `set_invitation` is the
-- original invite, not a withdrawal notice. Add the value needed by
-- app/api/invitations/handler.ts (withdrawInvitation).

-- ============ UP ============

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'invitation_withdrawn';

-- ============ DOWN ============
-- (commented; Postgres does not support removing a value from an enum type
-- directly — reversing this migration would require creating a new enum
-- type without the value, migrating all dependent columns to it, then
-- dropping the old type. Not implemented here; a real down is not required.)
