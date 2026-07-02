# Review — Issue #16: Migrate schema, Cluster 1 (Organization)

VERDICT: SHIP

## What was reviewed
- `git diff main...HEAD` (one new file: `supabase/migrations/20260702000001_cluster_1_organization.sql`, 57 lines).
- Cross-checked the migration column-by-column against the spec's exact schema AND the PRD source of truth (`documentation/prd/graceful_requirements_v10.md` §20.2 enums / §20.3 Cluster 1) — not just the written summaries.
- Confirmed git status: only the migration file is committed on the branch; `.pipeline/*` edits are the pipeline's own artifacts, no stray source changes.

## Correctness findings (all pass)
- Enums: `user_role` = admin, set_leader, member, guest; `vocal_capability` = none, lead, harmony, both — exact value order per PRD §20.2.
- FK-dependency order correct: church_groups -> users -> member_profiles; UP runs top-to-bottom on a fresh DB with no forward references.
- `users.email` is `varchar(255) unique` (nullable-unique) — NOT `not null`. Allows multiple phone-only guests. Correct.
- Both FKs declare `on delete cascade` (users.church_group_id, member_profiles.user_id) — transitive cascade works.
- `member_profiles` has NO `updated_at` — correctly omitted per spec/PRD.
- Defaults declared literally: role `'member'`, vocal_capability `'none'`, timezone `'America/Chicago'`, sms_opted_in false — no reliance on enum ordinal.
- `create extension if not exists "pgcrypto"` for `gen_random_uuid()`; no uuid-ossp dependency.
- B-tree index `idx_users_church_group_id` present.
- DOWN block (commented) drops in reverse order: member_profiles, users, church_groups, then vocal_capability, then user_role — enums last. Correct.
- Enum-ownership comment present noting Cluster 5 must not redefine vocal_capability.
- Timestamp prefix `20260702000001` sorts first; it is the only real migration in the dir (only `.gitkeep` besides it).

## Scope
Clean. No RLS, seed data, PostgREST lockdown, other-cluster tables, or TS type generation. config.toml / seed.sql / types.ts / client.ts untouched.

## Tests
Meaningful, not superficial: live Postgres (throwaway Docker postgres:16) exercised UP, default-application, multi-NULL email inserts, cascade delete, a duplicate invite_code rejection (real failure case), and full DOWN reversibility verified via information_schema/pg_type. App-code lint/typecheck/jest re-run green with the correct repo script. Green tests here genuinely reflect correct behavior.

## Notes (non-blocking)
- DOWN lives in a commented block by design (Supabase CLI is forward-only) — a documented spec decision, acceptable.
- This file becomes the reference pattern for later cluster migrations; it is clean and consistent.

No defects found. Ship.
