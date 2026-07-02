# Changes — Issue #16: Migrate schema, Cluster 1 (Organization)

## File added

- `supabase/migrations/20260702000001_cluster_1_organization.sql` (new)

## What it does

First-ever migration in the project (previously `supabase/migrations/`
contained only `.gitkeep`). Establishes the pattern for later cluster
migrations.

UP section:
- `create extension if not exists "pgcrypto"` for `gen_random_uuid()`.
- `user_role` enum: `admin`, `set_leader`, `member`, `guest`.
- `vocal_capability` enum: `none`, `lead`, `harmony`, `both` — created here
  (owned by Cluster 1) per the spec's enum-ownership decision, with a code
  comment noting Cluster 5 must NOT redefine it.
- Tables in FK-dependency order: `church_groups` → `users` →
  `member_profiles`, matching the exact column/type/constraint spec (uuid
  PKs via `gen_random_uuid()`, `users.email` nullable+unique, `role`
  default `'member'`, `vocal_capability` default `'none'`,
  `timezone` default `'America/Chicago'`, both FKs `on delete cascade`,
  `member_profiles` has no `updated_at`).
- B-tree index `idx_users_church_group_id` on `users.church_group_id`.

DOWN section (commented block, per spec's decision on reversibility given
Supabase CLI has no native up/down pair): drops `member_profiles`, `users`,
`church_groups`, then `vocal_capability`, then `user_role` — reverse
dependency order, enums last.

## Scope adherence

Only the three Organization tables and the two enums Cluster 1 needs. No
RLS policies, seed data, PostgREST lockdown, other clusters' tables, or
TypeScript type generation. `supabase/config.toml`, `supabase/seed.sql`,
`lib/supabase/types.ts`, `lib/supabase/client.ts` untouched.

## Verification performed

No `psql`/`supabase` CLI locally, so validated with a throwaway
`postgres:16` Docker container (started, tested, then removed —
no persistent infra changes):

1. Ran the UP block against a fresh database — all statements succeeded
   with zero errors (`CREATE EXTENSION`, `CREATE TYPE` x2, `CREATE TABLE`
   x3, `CREATE INDEX`).
2. Inserted a `church_groups` row with no explicit `timezone` — confirmed
   default `'America/Chicago'`.
3. Inserted two `users` rows with no `email` and no `role` — confirmed both
   inserts succeed (nullable-unique constraint allows multiple NULLs) and
   `role` defaults to `'member'`; inserted matching `member_profiles` rows
   with no `vocal_capability` — confirmed default `'none'`.
4. Deleted the `church_groups` row and confirmed cascade removed all
   `users` and `member_profiles` rows (0 remaining in both).
5. Ran the DOWN block — all drops succeeded; confirmed via
   `information_schema.tables` and `pg_type` that no Cluster 1 tables or
   enum types remain (0 rows each).

## Focus for Tester

- Confirm the migration file timestamp (`20260702000001`) sorts correctly
  ahead of any other migrations that may exist by review time.
- No app code (TS) was touched, so `bun run lint` / `bun run typecheck` /
  `bun test` should be unaffected by this change — worth a sanity run to
  confirm no regressions were introduced elsewhere.
- If the team has a real Supabase project/CLI available, running
  `supabase db reset` (or equivalent) against this migration is the
  strongest additional check beyond the manual Docker Postgres validation
  done here.

## Commit

Committed only the new migration file on the current branch
(`issue-16-sprint-0-migrate-schema-cluster-1-organization`), commit
`fe3a6b6`. Not pushed. Note: `.pipeline/spec.md` had pre-existing local
modifications not made by this stage and were intentionally left
uncommitted/untouched.
