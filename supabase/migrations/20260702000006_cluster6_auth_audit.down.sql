-- Rollback for 20260702000006_cluster6_auth_audit.sql
-- Drops audit_logs and google_calendar_tokens in dependency-safe order.
-- Dropping the tables removes their grants/indexes automatically.

BEGIN;

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS google_calendar_tokens;

COMMIT;
