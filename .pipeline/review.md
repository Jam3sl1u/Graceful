# Review: Issue #21 — Cluster 6 (Auth & Audit) schema migration

VERDICT: SHIP

## What was reviewed
- `git diff main...HEAD` firsthand (not just the summaries)
- Both SQL files read in full
- Cross-checked columns/types/FKs against PRD §20.8 and §20.9
- Spec §3.1–§3.4, §4, §5 edge cases, §7 acceptance-criteria mapping

## Correctness assessment (matches spec + PRD)
- `google_calendar_tokens`: uuid PK w/ `gen_random_uuid()`, UNIQUE `user_id`
  FK → `users(id) ON DELETE CASCADE`, both ciphertext text columns NOT NULL,
  `token_expiry` timestamptz, `calendar_id` varchar(200), `scope` text,
  created/updated_at defaults. Matches §3.1 and PRD §20.8 exactly. 1:1
  relationship enforced by UNIQUE (PRD §20.9). AC1 met.
- `audit_logs`: uuid PK, `church_group_id` FK → `church_groups(id) ON DELETE
  CASCADE`, nullable `user_id` FK → `users(id) ON DELETE SET NULL`,
  action/entity_type/entity_id, `metadata jsonb DEFAULT '{}'::jsonb`,
  created_at default. Matches §3.2 and PRD §20.8. AC2 met.
- BR-13 append-only (§3.3): unconditional `REVOKE UPDATE, DELETE ... FROM
  PUBLIC` plus a `DO $$` block that guards `authenticated`/`anon` revokes
  behind `pg_roles` existence checks so a bare local Postgres won't hard-fail
  (edge case #5). SELECT/INSERT untouched. AC3 met.
- Index on `(church_group_id, created_at DESC)` present (§3.4).
- Extension guard `CREATE EXTENSION IF NOT EXISTS pgcrypto` (edge case #4/#6).
- Both migrations wrapped in `BEGIN; ... COMMIT;`.
- `.down.sql` drops both tables in dependency-safe order via `DROP TABLE IF
  EXISTS` (§4, edge case #1). AC4 met.

## Scope compliance
- Only the two specified migration files were added under `supabase/migrations/`.
- No RLS, no encryption logic, no TS types, no API routes, no seed data.
- `users` / `church_groups` NOT created here (correctly left to #16).

## Tests: meaningful, not superficial
The tester did not merely trust changes.md. They ran the migration end-to-end
against a real throwaway Postgres 16 container with stub FK targets, and
independently verified: role-guarded revoke on bare Postgres, `\d` column
introspection vs spec, BR-13 privilege denial for BOTH `authenticated` and
`anon` (UPDATE/DELETE denied, INSERT/SELECT allowed), nullable user_id insert,
ON DELETE SET NULL vs CASCADE behavior, UNIQUE rejection, clean rollback, and a
full up→down→up cycle. This is real behavioral coverage of every AC and edge
case, appropriate for a DDL-only change with no SQL test framework in the repo.

## Notes (non-blocking)
- The commit swept `.pipeline/spec.md` and `.pipeline/changes.md` into the code
  commit. Unlike the prior "rogue spec" incident, this spec.md change IS this
  issue's own spec (regenerated #11 → #21), i.e. legitimate pipeline state, not
  an unrelated file. No action required, but future commits could keep
  `.pipeline/` churn out of the code commit for a cleaner diff.
- `REVOKE`-based enforcement relies on Supabase default privileges granting
  authenticated/anon DML on new tables; the tester confirmed denial empirically,
  so this is sound. (A future BEFORE UPDATE/DELETE trigger or RLS would be
  belt-and-suspenders, but is explicitly out of scope for #21.)

Nothing wrong with the code. Ship it.
