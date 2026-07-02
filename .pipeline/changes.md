# Changes for Issue #21 — [Sprint 0] Migrate schema — Cluster 6 (Auth & Audit)

## Files changed

- `supabase/migrations/20260702000006_cluster6_auth_audit.sql` (new)
  Forward migration. Wrapped in `BEGIN; ... COMMIT;`.
  - `CREATE EXTENSION IF NOT EXISTS pgcrypto;` for `gen_random_uuid()`.
  - Creates `google_calendar_tokens`: uuid PK, UNIQUE `user_id` FK →
    `users(id) ON DELETE CASCADE`, encrypted-ciphertext text columns
    (`access_token_encrypted`, `refresh_token_encrypted`), `token_expiry`
    timestamptz, `calendar_id` varchar(200), `scope` text, `created_at` /
    `updated_at` timestamptz defaults.
  - Creates `audit_logs`: uuid PK, `church_group_id` FK →
    `church_groups(id) ON DELETE CASCADE`, nullable `user_id` FK →
    `users(id) ON DELETE SET NULL`, `action` varchar(100), `entity_type`
    varchar(50), `entity_id` uuid, `metadata` jsonb default `'{}'`,
    `created_at` timestamptz default `now()`.
  - BR-13 append-only enforcement: unconditional
    `REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC;`, followed by a
    `DO $$ ... $$` block that individually checks `pg_roles` for
    `authenticated` and `anon` before revoking from each, so the migration
    doesn't fail on a bare local Postgres missing those roles.
  - Index: `audit_logs_church_group_id_created_at_idx` on
    `(church_group_id, created_at DESC)`.

- `supabase/migrations/20260702000006_cluster6_auth_audit.down.sql` (new)
  Rollback migration, wrapped in `BEGIN; ... COMMIT;`. Drops `audit_logs`
  then `google_calendar_tokens` via `DROP TABLE IF EXISTS` (dependency-safe
  order; dropping tables removes their grants/indexes automatically).

No other files were touched. `supabase/config.toml`, `supabase/seed.sql`,
and `supabase/README.md` were left as-is per spec. Note: `.pipeline/spec.md`
also shows as modified in `git status`, but that change predates this task
(it's pipeline scaffolding reflecting the current spec, not part of this
issue's code change) and was intentionally left out of the commit.

## Verification performed

No SQL-specific test suite exists in the repo, so verification was done
directly against a throwaway Postgres 16 instance (`docker run
postgres:16-alpine`), with minimal stub `users` / `church_groups` tables
(never committed) to satisfy the FK targets that Cluster 1 (#16) will
eventually provide:

1. Forward migration applies cleanly (with and without `authenticated`/`anon`
   roles present) — confirms edge case #5 (role-guarded revoke doesn't
   hard-fail on bare Postgres).
2. `CREATE EXTENSION IF NOT EXISTS pgcrypto` is idempotent on re-run.
3. BR-13: as role `authenticated`, `SELECT` and `INSERT` succeed; `UPDATE`
   and `DELETE` are denied with `permission denied for table audit_logs`
   (AC3 / edge case #2).
4. `audit_logs.user_id` accepts `NULL` (system-triggered rows) — edge case #3.
5. Deleting a referenced `users` row: `audit_logs.user_id` becomes `NULL`
   (`ON DELETE SET NULL`, log row preserved) and the user's
   `google_calendar_tokens` row is cascade-deleted (`ON DELETE CASCADE`,
   1:1 relationship).
6. `google_calendar_tokens.user_id` UNIQUE constraint rejects a second
   token row for the same user.
7. Down migration drops both tables cleanly, leaving `users` /
   `church_groups` untouched; forward migration re-applies successfully
   after rollback (full up/down/up cycle) — AC4.

Also ran the repo's existing checks, both clean (no findings, since only
new `.sql` files were added):
- `bun run typecheck`
- `bun run lint`

## What the Tester should focus on

- Confirm the two new files exist under `supabase/migrations/` with exactly
  the specified filenames and are the only new/changed files from this
  issue (aside from the pre-existing `.pipeline/spec.md` diff noted above,
  which predates this task).
- Confirm no RLS policies, encryption logic, TS types, API routes, or seed
  data were added (explicitly out of scope per the spec).
- Confirm `users` / `church_groups` tables were NOT created here (blocked by
  #16, intentionally out of scope).
- If a real Postgres/Supabase instance is available in CI, consider running
  the forward + down migration end-to-end there too.
