# Review — Merge: Issue #32 + Issue #28 (main)

## VERDICT: SHIP (both issues)

This branch merges `main` (#28 member removal) into the #32 auth-matrix/coverage
branch. Both feature sets are retained; merge conflicts resolved without dropping
either side's product code or tests.

---

## Issue #32: API auth-matrix tests + coverage reporting — SHIP

- Code diff scoped to jest.config.ts, package.json, .github/workflows/ci.yml,
  tests/support/api-auth.ts, and tests/unit/app/api/auth-matrix.test.ts.
- Harness exports match spec; consolidated matrix exercises real handlers with
  correct arity and role gating.
- CI swaps `bun run test` → `bun run test:coverage` in the `checks` job only.
- No `coverageThreshold` added.

**Merge note:** The original T4 stub-pin test for #28 was superseded by #28's
full per-route test suite from `main`. This is correct — #28 is no longer a stub.

---

## Issue #28: Remove/archive member with PII anonymization — SHIP

- `DELETE /api/church-group/members/:id` implemented via `remove_church_group_member`
  RPC with BR-12 locking, PII anonymization, and audit log.
- Unit tests (13 cases) and RLS integration test added.
- Member directory excludes anonymized users.

**Pre-merge action (non-blocking for review verdict):** Run
`supabase start && bun run test:rls` to exercise the concurrent-removal
integration test against live Postgres before merging to production.
