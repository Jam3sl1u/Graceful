# Changes — Issue #20: Migrate schema — Cluster 5 partial

## File created

- `supabase/migrations/0005_cluster5_partial.sql`

## What it does

Single reversible SQL migration with `-- migrate:up` / `-- migrate:down` sections
(no paired `_down.sql`, matching the spec's chosen convention since no prior
migrations exist in the repo).

**Up section**, in order:
1. Two enums, each guarded with `DO $$ ... EXCEPTION WHEN duplicate_object $$`:
   - `chat_pref` — `('all', 'mentions')`
   - `notification_type` — the 11-value catalog from PRD §14 (`set_invitation`,
     `invitation_reminder`, `invitation_accepted`, `invitation_denied`,
     `practice_reminder`, `setlist_released`, `scheduling_conflict`,
     `chat_mention`, `devotion_shared`, `new_church_document`,
     `google_calendar_event`). This enum is not in PRD §20.2's list but is
     referenced by `notifications.type` in §20.7 — the spec resolves this gap
     by having the migration define it here.
2. `availability` table (uuid PK, FK to `users`/`church_groups` ON DELETE
   CASCADE, `date`, `is_available` default true, nullable `note`,
   `created_at`), with `UNIQUE (user_id, date)` and an index on
   `(church_group_id, date)`.
3. `notification_preferences` table (uuid PK, `user_id` UNIQUE FK, the 8
   boolean/int preference columns with PRD-specified defaults — notably
   `reminder_email` defaults `false` while the other booleans default `true`
   — `chat_preference chat_pref` default `'mentions'`, `gcal_sync_enabled`
   default `false`). No BR-14 CHECK constraint (intentionally left to the API
   layer per spec).
4. `notifications` table (uuid PK, FKs to `church_groups`/`users`, `type
   notification_type`, `title varchar(200)`, nullable `body`, nullable
   polymorphic `link_entity_type`/`link_entity_id` pair with no FK on the
   latter, `is_read` default false, `created_at`), with indexes on
   `(user_id, is_read)` and `(user_id, created_at DESC)`.

**Down section** drops in reverse dependency order: `notifications` →
`notification_preferences` → `availability` → `notification_type` →
`chat_pref`. Does not touch `users` or `church_groups` (owned by issue #16).

## Out of scope (confirmed not done)

- No `chat_rooms` / `chat_messages` / `chat_mentions` (Phase 2).
- No RLS / `ENABLE ROW LEVEL SECURITY` (issue #13).
- No `vocal_capability` enum (Cluster 1 / #16).
- No BR-14 CHECK constraint.
- No seed data, no API routes, no TS types/Zod schemas, no config.toml changes.

## Verification performed

No SQL lint/test tooling exists in this repo's `package.json` scripts
(`lint`/`typecheck`/`test` are all JS/TS-oriented and don't touch `.sql`
files), so verification was done directly against Postgres:

- Spun up a throwaway `postgres:15-alpine` Docker container, created stub
  `church_groups`/`users` tables (standing in for issue #16's not-yet-present
  migration), then applied this migration's `migrate:up` block — it applied
  cleanly.
- Confirmed via `\d` that every column, type, default, nullability, unique
  constraint, index, and FK on `availability`, `notification_preferences`,
  and `notifications` matches the spec's tables exactly (§3.3–3.5), and that
  `chat_pref` / `notification_type` enum values match exactly (§3.2).
- Applied `migrate:down` and confirmed all 3 tables and both enums were
  removed, leaving only the stub `users`/`church_groups` tables intact.
- Re-ran `migrate:down` a second time and confirmed `DROP ... IF EXISTS`
  guards make it a no-op (NOTICE: does not exist, skipping) rather than an
  error.
- Re-ran `migrate:up` again and separately re-ran the `chat_pref` enum
  `CREATE TYPE` guard block to confirm the `duplicate_object` exception
  handler prevents an error on re-creation.
- Removed the Docker container after verification (no artifacts left behind
  in the repo).

## Focus for Tester

- Confirm the migration is a no-op / correctly errors (missing relation) when
  applied to a DB that does not yet have `church_groups`/`users` — this is
  expected behavior per the spec, not a bug.
- Confirm the migration applies cleanly and matches schema exactly once
  issue #16's Cluster 1 migration is present ahead of it.
- Confirm no RLS, no Phase-2 chat tables, and no `vocal_capability` enum were
  introduced.

## Git

Committed on the current branch
(`issue-20-sprint-0-migrate-schema-cluster-5-partial-availability-notification-prefs-notifications`)
as commit `b42ad83`: "Add Cluster 5 partial migration (availability,
notification_preferences, notifications)". Not pushed.
