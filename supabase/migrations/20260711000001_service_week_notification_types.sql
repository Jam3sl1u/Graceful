-- Migration: Service week notification types
-- Issue #39 (BR-17): notification types for service week cancel/reactivate.
--
-- notification_type (created in 20260702000005_cluster_5_partial.sql) has no
-- value for a cancelled/reactivated service week. Add the two values needed
-- by app/api/service-weeks/[id]/handler.ts (cancelServiceWeek /
-- reactivateServiceWeek).

-- ============ UP ============

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'service_week_cancelled';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'service_week_reactivated';

-- ============ DOWN ============
-- (commented; Postgres does not support removing a value from an enum type
-- directly — reversing this migration would require creating a new enum
-- type without the two values, migrating all dependent columns to it, then
-- dropping the old type. Not implemented here; a real down is not required.)
