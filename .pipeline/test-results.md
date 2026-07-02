# Test Results: Issue #20 — [Sprint 0] Migrate schema — Cluster 5 partial

## Nature of this change

Single new SQL migration file (`supabase/migrations/0005_cluster5_partial.sql`),
no application/JS/TS code touched. `git show --stat HEAD` confirms the commit
is exactly one 94-line file addition. There is no SQL test/lint tooling in
this repo, so verification was done by independently standing up a throwaway
Postgres container and re-running every check myself rather than trusting the
coder's changes.md narrative.

## Verification performed (independently re-run, not just trusted from changes.md)

| # | Check | Result |
|---|-------|--------|
| 1 | `bun run lint` | PASS — no output/errors |
| 2 | `bun run typecheck` | PASS — no output/errors |
| 3 | `bun run test` (Jest, pre-existing suite: `tests/unit/lib/api/response.test.ts`) | PASS — 3/3 tests, unaffected (expected, since no JS/TS changed) |
| 4 | Spun up a fresh `postgres:15-alpine` Docker container, created stub `church_groups`/`users` tables, applied the `-- migrate:up` block | PASS — applied cleanly, no errors |
| 5 | `\d availability`, `\d notification_preferences`, `\d notifications`, `\dT+ chat_pref`, `\dT+ notification_type` | PASS — every column, type, default, nullability, PK/UNIQUE/FK constraint, and index matches spec §3.3–3.5 exactly; enum values match §3.2 exactly and in listed order |
| 6 | `pg_class.relrowsecurity` for all 3 tables | PASS — `f` (false) on all three; no RLS enabled, matching out-of-scope requirement |
| 7 | `pg_constraint` on `notification_preferences` | PASS — only `pkey`, `unique(user_id)`, `fkey(user_id)`; no BR-14 CHECK constraint present |
| 8 | `\dt public.*` after up | PASS — exactly `availability`, `notification_preferences`, `notifications` added alongside the pre-existing stub `church_groups`/`users`; no `chat_rooms`/`chat_messages`/`chat_mentions`/`vocal_capability` |
| 9 | Applied `-- migrate:down` | PASS — dropped exactly `notifications`, `notification_preferences`, `availability`, `notification_type`, `chat_pref` in that reverse-dependency order; `\dt`/`\dT` afterward show only the stub `church_groups`/`users` tables remain, 0 custom types remain |
| 10 | Re-ran `-- migrate:down` a second time | PASS — idempotent no-op; `NOTICE: ... does not exist, skipping` for every object, no errors |
| 11 | Re-ran the `chat_pref` `CREATE TYPE` guard block a second time | PASS — `duplicate_object` exception handler suppressed the error, statement returned `DO` cleanly |
| 12 | **Failure-case check**: applied `-- migrate:up` against a fresh Postgres container that never had `church_groups`/`users` created | PASS (correctly fails) — `ERROR: relation "users" does not exist`, exit code 3. This is the spec's documented expected behavior (§5, "Apply order dependency"), not a bug |
| 13 | Docker containers removed after testing | Confirmed cleaned up, no artifacts left in repo |
| 14 | `grep` for `chat_rooms\|chat_messages\|chat_mentions\|vocal_capability\|ROW LEVEL SECURITY` in the migration file | PASS — only appears in a comment noting these are out of scope; none are actually created |

## Targeted checks from the coder's "Focus for Tester" list

1. **Migration correctly errors on a DB missing `church_groups`/`users`.** Confirmed (#12 above) — `ERROR: relation "users" does not exist"`, matching spec's documented expected behavior, not treated as a bug.
2. **Migration applies cleanly and matches schema exactly with stub `church_groups`/`users` present.** Confirmed (#4–5 above) — column-by-column match against spec §3.3–3.5.
3. **No RLS, no Phase-2 chat tables, no `vocal_capability` enum.** Confirmed (#6, #8, #14 above).

## Summary

All independently-run checks pass. No new JS/TS tests were written because
this issue introduces no application code — verification is necessarily
SQL/schema-level, performed against a real Postgres instance rather than by
reading the file alone. Every claim in the coder's changes.md was reproduced
firsthand (not taken on faith), including the round-trip up/down behavior,
the idempotency guards, and the intentional missing-relation failure case.

**Result: PASS. No blocking issues found. Ready for Reviewer.**
