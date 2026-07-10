# Test Results — Merge: Issue #32 + Issue #28 (main)

## Overall verdict: PASS (post-merge verification pending)

This branch merges `main` (#28 member removal) into Issue #32 (auth-matrix +
coverage). Both feature sets are retained. Post-merge commands were run to
confirm the combined suite is green.

---

## Issue #32 results (pre-merge baseline)

- `bun run typecheck` — pass.
- `bun run lint` — pass.
- `bun run test` — 16 suites, 192 tests, all passed.
- `bun run test:coverage` — pass; report-only (no `coverageThreshold`).
- Harness shapes and handler arity verified against source.

**Note:** The #32 T4 stub-pin test for `DELETE /api/church-group/members/:id`
was superseded during merge by #28's full 13-test per-route suite.

---

## Issue #28 results (from main)

- `bun run typecheck` — 0 errors.
- `bun run lint` — 0 errors/warnings.
- `bun run test` — 186/186 unit tests (15 suites) on main alone.
- `bun run test:rls` — integration file loads and skips without live Supabase.

**Gap:** `tests/integration/rls/tables/member-removal.test.ts` has not been run
against a live Postgres instance. Run `supabase start && bun run test:rls` before
merge to exercise concurrent BR-12 locking.

---

## Post-merge verification

- `bun run typecheck` — pass.
- `bun run lint` — pass.
- `bun run test` — **16 suites, 206 tests, all passed.**
- `bun run test:coverage` — pass (Statements 90.69%, Branches 85.33%).

One post-merge fix: `auth-matrix.test.ts`'s `getChurchGroupMembers` mock was updated
to support `.eq().is()` chaining required by #28's `anonymized_at` roster filter.
