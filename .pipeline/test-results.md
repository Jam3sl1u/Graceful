# Test Results: Issue #21 — [Sprint 0] Migrate schema — Cluster 6 (Auth & Audit)

## Nature of this change

Pure SQL migration (`supabase/migrations/20260702000006_cluster6_auth_audit.sql`
+ companion `.down.sql`), no application code. There is no SQL test framework
in this repo, so verification means: (1) re-run the repo's standard checks,
and (2) independently execute the migration against a real, disposable
Postgres instance and manually verify every acceptance criterion and edge
case named in the spec — not trusting the coder's changes.md narrative.

## Repo-standard checks (independently re-run)

| # | Check | Result |
|---|-------|--------|
| 1 | `bun run typecheck` | PASS — `tsc --noEmit`, no errors |
| 2 | `bun run lint` | PASS — `eslint .`, no errors |
| 3 | `bun run test` (Jest, pre-existing suite) | PASS — 3/3 tests in `tests/unit/lib/api/response.test.ts`, unaffected (no TS files touched by this issue) |
| 4 | `bun test` (Bun's native runner) | Fails, but pre-existing/environmental and unrelated to this change — it also picks up `tests/e2e/*.spec.ts` (Playwright config, not meant to run under Bun's runner) and a `server-only` import error in the same Jest test file when run under Bun. Confirmed via `git diff a60f52b HEAD -- tests/ package.json` that no test files or configs were touched by this issue's commit. The repo's actual test script is `jest` (`bun run test`), which passes cleanly. Not a regression. |

## Independent migration verification (Docker `postgres:16-alpine`, throwaway container, minimal stub `users`/`church_groups` tables per spec's own instructions)

| # | Check | Result |
|---|-------|--------|
| 1 | Forward migration applies cleanly on bare Postgres with **no** `authenticated`/`anon` roles present | PASS — confirms edge case #5 (role-guarded revoke doesn't hard-fail) |
| 2 | `\d google_calendar_tokens` / `\d audit_logs` match spec's column/type/nullability/default table exactly (§3.1, §3.2) | PASS — AC1, AC2 |
| 3 | Index `audit_logs_church_group_id_created_at_idx` on `(church_group_id, created_at DESC)` exists | PASS — §3.4 |
| 4 | `CREATE EXTENSION IF NOT EXISTS pgcrypto` is idempotent (re-ran manually) | PASS — edge case #4/#6 |
| 5 | BR-13, role `authenticated` (granted SELECT+INSERT only): `INSERT` succeeds (metadata defaults to `{}`), `SELECT` succeeds, `UPDATE` and `DELETE` both denied with `permission denied for table audit_logs` | PASS — AC3, edge case #2 |
| 6 | BR-13, role `anon` (granted SELECT+INSERT only): `UPDATE`/`DELETE` both denied | PASS — AC3, edge case #2 |
| 7 | `audit_logs.user_id = NULL` insert (system-triggered row) succeeds | PASS — edge case #3 |
| 8 | Deleting the referenced `users` row: `audit_logs.user_id` → `NULL` (row preserved, `ON DELETE SET NULL`); the user's `google_calendar_tokens` row is cascade-deleted (`ON DELETE CASCADE`) | PASS |
| 9 | `google_calendar_tokens.user_id` UNIQUE constraint rejects a second token row for the same user (`duplicate key value violates unique constraint "google_calendar_tokens_user_id_key"`) | PASS |
| 10 | Down migration (`DROP TABLE IF EXISTS audit_logs; DROP TABLE IF EXISTS google_calendar_tokens;`) drops both tables cleanly; `users`/`church_groups` left untouched | PASS — edge case #1 |
| 11 | Full up → down → up cycle: forward migration re-applies successfully after rollback | PASS — AC4 |

## Scope / out-of-scope compliance (per spec's "do NOT add" list)

- Only 2 new files: `supabase/migrations/20260702000006_cluster6_auth_audit.sql`
  and its `.down.sql` companion. Confirmed via `git show --stat` on the
  commit (`a663674`) — no other application files (`supabase/config.toml`,
  `supabase/seed.sql`, `supabase/README.md`) were touched.
- No RLS policies, no encryption/decryption logic, no TypeScript types, no
  API routes, no seed data, no `users`/`church_groups` table creation.
  Confirmed by reading both SQL files in full — verified.
- Note: `.pipeline/changes.md` and `.pipeline/spec.md` also appear in the
  commit diff (pipeline scaffolding churn from the workflow itself, not
  application code) — inconsequential to correctness of the migration.

## Summary

All independently-run checks pass, including a real execution of both the
forward and rollback migrations against a live Postgres 16 instance covering
every acceptance criterion (AC1–AC4) and every edge case named in the spec
(#1–#6). No discrepancies found between the coder's changes.md claims and
what was independently reproduced.

**Result: PASS. No blocking issues found. Ready for Reviewer.**
