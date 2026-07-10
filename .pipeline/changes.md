# Changes — Issue #32: API auth-matrix tests for Sprint 0–1 routes

## Open questions — resolution applied

A human resolved spec.md's two OPEN QUESTIONS with: proceed as scoped — add
coverage reporting config, write auth-matrix tests for the 7 already-implemented
route groups, and add a test that pins the 501 stub for the #28 route. Defer the
real auth-matrix for member-removal until #28 is actually implemented. This is
exactly what spec.md's own "This spec assumes" / default text already described
for both open questions, so the implementation below follows spec.md as written:

1. `DELETE /api/church-group/members/:id` (#28) is left as a 501 stub; only its
   current stub behavior is pinned under test (T4). The real four-case auth
   matrix is deferred until #28 lands.
2. No real JWT signing was introduced. The harness mocks `@clerk/nextjs/server`'s
   `auth()` and injects a `UserLookup`, matching the existing per-route test
   pattern (`tests/unit/app/api/service-weeks-route.test.ts`,
   `tests/unit/app/api/instruments-route.test.ts`).

## Files changed

### `jest.config.ts` (modified) — T1
Added `collectCoverageFrom` (scoped to `app/api/church-group/**`,
`app/api/profile/**`, `app/api/instruments/**`, `lib/api/**`),
`coveragePathIgnorePatterns`, `coverageDirectory`, and `coverageReporters:
["text-summary", "lcov"]`. No `coverageThreshold` was added (report-only, per
spec, so this doesn't fail unrelated PRs). Nothing pre-existing in the config
was changed.

### `package.json` (modified) — T1
Added `"test:coverage": "jest --coverage"` next to the existing `"test": "jest"`
script.

### `.github/workflows/ci.yml` (modified) — T1
In the `checks` job, changed `- run: bun run test` to `- run: bun run
test:coverage` so CI emits the coverage text-summary in the logs. The
`check-secrets` and `rls-integration` jobs, and every other step in `checks`,
are untouched.

### `.gitignore` — not modified
`/coverage` was already present under the "testing" section; no duplicate entry
added.

### `tests/support/api-auth.ts` (new) — T2
Reusable auth-matrix harness exporting exactly `makeLookup(role, overrides?)`,
`mockClerkAuthed(jwt?)`, `mockClerkAnonymous()`, and `makeJsonReq(body?)`, with
the same resolved shapes as the copy-pasted per-route helpers (`userId:
"clerk_test"` / `getToken` for authed, `userId: null` for anonymous; default
fixed IDs `userId: "user-1"`, `churchGroupId: "group-1"`, overridable). It casts
the mocked `auth` import from `@clerk/nextjs/server` internally; consuming test
files must still declare `jest.mock("@clerk/nextjs/server", () => ({ auth:
jest.fn() }))` at the top of their own file so the module registry resolves to
the same mock instance. No existing test file was rewritten or migrated — this
module is purely additive.

### `tests/unit/app/api/auth-matrix.test.ts` (new) — T3
Consolidated auth-matrix pass consuming the harness, covering the admin-gated
handler-style routes: `patchMemberRole` (#27), `getAuditLog` (#29),
`addInstrument` / `promoteInstrument` / `deleteInstrument` (#31), and
`getChurchGroupMembers` (#26, admin-vs-guest gating). For each handler it
asserts the applicable matrix cells (unauth→401, disallowed-role→403,
malformed-body→400 for the two routes with a request body, admin-success 2xx),
calling each handler with the exact argument arity used by its existing
per-route test file, and reusing (not inventing) the same chainable/RPC
Supabase mock shapes from those files (`instruments-route.test.ts`,
`church-group-members-role-route.test.ts`, `audit-log-route.test.ts`,
`church-group-members-route.test.ts`). `beforeEach` resets both the `auth` and
`getSupabaseClient` mocks.

### `tests/unit/app/api/church-group-members-id-route.test.ts` (new) — T4
Pins the current 501 stub behavior of `DELETE
/api/church-group/members/[id]`: calls `DELETE({} as unknown as NextRequest)`
and asserts `res.status === 501` and `(await res.json()).code ===
"NOT_IMPLEMENTED"`. Includes a top-of-file comment noting this is issue #28
(Remove/archive member) and should be replaced with the full auth matrix once
#28 is implemented. No Clerk/Supabase mocking needed — the stub short-circuits
before any auth code runs.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes (0 errors, 0 warnings; verified with no stray
  `coverage/` output directory present, since generated coverage artifacts are
  gitignored but not eslint-ignored).
- `bun run test` and `bun run test:coverage` — both pass: 16 suites, 192 tests.
  The coverage text-summary lists all eight #24–#31 route files plus
  `lib/api/*` with non-zero coverage; `members/[id]/route.ts` registers because
  of the new T4 test.
- No existing test file's assertions were touched, weakened, or rewritten.
- No real network calls or real JWT signing were introduced.

## What the Tester should focus on
- Confirm `tests/support/api-auth.ts`'s exported shapes exactly match what
  `service-weeks-route.test.ts` / `instruments-route.test.ts` already use, so
  it's a true drop-in replacement for future sprints (not just superficially
  similar).
- In `auth-matrix.test.ts`, confirm each handler call's argument order/arity
  matches its real per-route test file exactly (e.g. `promoteInstrument(req,
  id, lookup)`, `getAuditLog(req, lookup)`) and that no assumption papered over
  a real behavior difference.
- Confirm the CI diff only swaps `bun run test` → `bun run test:coverage` in
  the `checks` job and leaves `check-secrets` / `rls-integration` untouched.
- Confirm `jest.config.ts`'s new coverage fields don't introduce a
  `coverageThreshold` (none should exist) — a failing threshold would block
  unrelated PRs, which spec.md explicitly says to avoid.
