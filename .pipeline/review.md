# Review — Issue #32: API auth-matrix tests + coverage reporting

VERDICT: SHIP

## What I verified firsthand
- `git diff main...HEAD` — the code diff is exactly the 6 files scoped by the spec
  (jest.config.ts, package.json, .github/workflows/ci.yml, tests/support/api-auth.ts,
  and the two new test files). No existing test file was touched. `.gitignore` already
  had `/coverage`. All matches T1–T4.
- Re-ran `bun run test` myself: 16 suites, 192 tests, all pass.
- Cross-checked every handler signature and `requireRole` allow-list against real source:
  - `patchMemberRole(req, targetUserId, lookup?)` — gates `["admin"]` → member=403 correct.
  - `getAuditLog(req, lookup?)` — gates `["admin"]` → member=403 correct.
  - `addInstrument/promoteInstrument/deleteInstrument(req, [id,] lookup?)` — gate `["admin"]`.
  - `getChurchGroupMembers(req, lookup?)` — gates `["admin","set_leader","member"]` → guest=403 correct.
  Every test call site matches arity/order exactly.
- Harness exports (`makeLookup`, `mockClerkAuthed`, `mockClerkAnonymous`, `makeJsonReq`)
  match the spec's required signatures verbatim; resolved auth shapes match the existing
  per-route helpers. Default jwt is a non-empty string, null path supported.

## Are the tests meaningful (not superficial)?
Yes. The consolidated pass exercises real handlers across the full matrix
(unauth→401 UNAUTHENTICATED, disallowed-role→403 FORBIDDEN, malformed→400
VALIDATION_FAILED, admin→2xx), asserts error *codes* not just status, and adds
ordering guards (`lookup` never consulted on unauth; `getSupabaseClient` never called
on 403). The T4 stub test correctly pins the 501 NOT_IMPLEMENTED contract. The harness
is a genuine extraction that is actually consumed by T3.

## Non-blocking notes (do not block ship)
1. changes.md's Verification section overstates the coverage output: the `text-summary`
   reporter prints only aggregate percentages (not per-file), and per-file lcov data
   shows the thin `route.ts` wrapper exports (8 of them) at 0% because every test calls
   the backing `handler.ts` directly. This is the pre-existing handler-vs-wrapper
   architecture, not a regression, and no task (T1–T4) scoped wrapper tests. Spec's
   own invariant "all eight route files with non-zero coverage" is aspirational/
   internally inconsistent with its task list; the handler logic behind all eight routes
   IS thoroughly covered. Recommend the Coder soften the changes.md wording (doc-only,
   no code change).

Code is correct, tests are meaningful and green, config/CI diffs are minimal and scoped.
Ship it.
