# Spec — Issue #16: Migrate schema, Cluster 1 (Organization)

## OPEN QUESTIONS
None that block implementation. Two decisions are made explicit below (both low-risk, chosen to match repo conventions and the PRD). Flag if you disagree:

1. **Down migration format.** Supabase CLI migrations are forward-only `.sql` files with no native up/down file pair. To satisfy the "reversible / down migration written" acceptance criterion without inventing tooling the repo doesn't have, include the down SQL in the same migration file inside a commented `-- DOWN` block. Lowest-friction, keeps one CLI-applicable file.
2. **`vocal_capability` enum ownership.** `member_profiles.vocal_capability` (Cluster 1) needs the `vocal_capability` enum, which the backlog nominally assigns to a later cluster (#11/Cluster 5). Cluster 1 cannot compile without it, so create it here. See "Enum ownership decision".

## Scope

ONLY the three Organization tables (`church_groups`, `users`, `member_profiles`) and the enums they require (`user_role`, `vocal_capability`). Do NOT add RLS policies (#22), seed data, PostgREST lockdown (#14), other clusters' tables, or TypeScript type generation.

## Current repo state (verified)

- `supabase/migrations/` contains only `.gitkeep` — this is the FIRST migration in the project; there is no prior SQL to copy from. This file becomes the reference pattern for all later cluster migrations.
- `supabase/config.toml` is a placeholder (`project_id = "graceful"` only). Do not edit it for this issue.
- `supabase/seed.sql`, `lib/supabase/types.ts`, `lib/supabase/client.ts` are all placeholders for later issues — leave untouched.
- PRD source of truth for the schema: `documentation/prd/graceful_requirements_v10.md` §20.2 (enums) and §20.3 (Cluster 1). Column definitions below are transcribed from there.

## File to create

### `supabase/migrations/20260702000001_cluster_1_organization.sql` (NEW)

Timestamp prefix `20260702000001` — Supabase orders migrations lexicographically by the `YYYYMMDDHHMMSS_` prefix, so this must sort before any future cluster migration. Structure:

```
-- Migration: Cluster 1 — Organization
-- Tables: church_groups, users, member_profiles
-- Enums: user_role, vocal_capability (vocal_capability is created here and reused by Cluster 5)

-- ============ UP ============
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- enums (user_role, vocal_capability)
-- tables in FK dependency order: church_groups -> users -> member_profiles
-- index on users.church_group_id

-- ============ DOWN ============
-- (commented; run to reverse — drop in reverse dependency order)
-- drop table if exists member_profiles;
-- drop table if exists users;
-- drop table if exists church_groups;
-- drop type if exists vocal_capability;
-- drop type if exists user_role;
```

## Enum ownership decision

Create BOTH enums in this migration:
- `user_role` — values in order: `admin`, `set_leader`, `member`, `guest`.
- `vocal_capability` — values in order: `none`, `lead`, `harmony`, `both`.

Add a comment noting `vocal_capability` is created here and must NOT be redefined by the later Cluster 5 migration.

## Exact schema (from PRD §20.2 / §20.3)

### Table `church_groups` (root — has NO church_group_id FK)
| Column | Type | Constraints |
| --- | --- | --- |
| id | uuid | PK, default `gen_random_uuid()` |
| name | varchar(100) | not null |
| denomination | varchar(100) | null |
| timezone | varchar(50) | not null, default `'America/Chicago'` |
| logo_url | text | null (R2 object key, never a public URL) |
| invite_code | varchar(20) | not null, **unique** |
| created_at | timestamptz | not null, default `now()` |
| updated_at | timestamptz | not null, default `now()` |

### Table `users`
| Column | Type | Constraints |
| --- | --- | --- |
| id | uuid | PK, default `gen_random_uuid()` |
| clerk_id | varchar(50) | not null, **unique** |
| church_group_id | uuid | not null, FK → `church_groups(id)` on delete cascade |
| role | user_role | not null, default `'member'` |
| name | varchar(100) | not null |
| email | varchar(255) | **null**, **unique** (nullable-unique: Postgres allows multiple NULLs) |
| phone | varchar(20) | null |
| sms_opted_in | boolean | not null, default `false` |
| created_at | timestamptz | not null, default `now()` |
| updated_at | timestamptz | not null, default `now()` |

### Table `member_profiles`
| Column | Type | Constraints |
| --- | --- | --- |
| id | uuid | PK, default `gen_random_uuid()` |
| user_id | uuid | not null, **unique**, FK → `users(id)` on delete cascade |
| vocal_capability | vocal_capability | not null, default `'none'` |
| bio | text | null |
| created_at | timestamptz | not null, default `now()` |

Note: `member_profiles` per PRD has NO `updated_at` — do not add one.

## Requirements the implementation must satisfy

- UUID v4 PKs everywhere via `gen_random_uuid()` (pgcrypto). Do NOT depend on `uuid-ossp`.
- Create tables in FK-dependency order (church_groups, then users, then member_profiles) so the UP migration runs top-to-bottom on a fresh DB.
- Add a b-tree index on `users.church_group_id` (queried on nearly every request per the issue's Implementation Notes). `clerk_id` and `email` uniqueness already provide their own indexes; no extra index needed for those.
- `users.email` must be nullable AND unique — a plain `unique` constraint is correct (Postgres treats NULLs as distinct, so multiple phone-only guest users insert fine). Do NOT mark it `not null`.
- FKs use `on delete cascade`: deleting a church group removes its users; deleting a user removes their profile. Matches PRD §20 relationships ("One-to-many: church_groups → users"; "One-to-one: users → member_profiles").
- DOWN block drops in reverse dependency order: member_profiles, users, church_groups, then enum types last.

## Edge cases the implementation must handle

1. **Fresh-instance idempotency** of the extension: `create extension if not exists "pgcrypto"`.
2. **Nullable-unique email**: two guest users with no email must both insert successfully — verify the constraint is `unique`, not a `not null` variant.
3. **Enum defaults declared explicitly**: `role` default `'member'` (3rd value), `vocal_capability` default `'none'` (1st value). Do not rely on enum ordinal.
4. **Timezone default** must be exactly the IANA string `'America/Chicago'`.
5. **Cascade paths**: deleting a `church_groups` row must cascade to `users` and transitively (via the users→member_profiles FK cascade) to `member_profiles`. Confirm both FKs declare `on delete cascade`.
6. **Reversibility with no orphans**: running the DOWN block after the UP block on a fresh DB must remove every Cluster 1 object, including both enum types. Enums must be dropped AFTER all referencing tables.
7. **Clean run on fresh Supabase**: the whole UP block must execute with zero errors against an empty database (acceptance criterion). No forward references, no reliance on objects from other clusters.

## Pattern to follow

No prior migration exists — this file establishes the pattern for later clusters (#8–#12 in the backlog). Keep it clean:
- lowercase SQL keywords, snake_case identifiers (matches PRD naming).
- `-- ============ UP ============` / `-- ============ DOWN ============` section banners.
- One migration file per cluster (per `supabase/README.md`).

## Out of scope (do not touch)

- `supabase/seed.sql`, `supabase/config.toml`, `lib/supabase/types.ts`, `lib/supabase/client.ts`.
- RLS policies (#22), PostgREST lockdown (#14), any Cluster 2–6 tables/enums beyond the two enums Cluster 1 needs.
- Regenerating TypeScript types.
