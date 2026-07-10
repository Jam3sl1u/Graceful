# Test Results — Issue #32: API auth-matrix tests for Sprint 0–1 routes

## Overall verdict: PASS (with one documentation-accuracy note, non-blocking)

All required commands were independently re-run (not trusted from changes.md) and all
passed. One claim in `changes.md` about what the coverage report shows is overstated /
inaccurate; it does not correspond to any failing test or threshold, but the Reviewer
should be aware of it.

## Commands run

### `bun install`
Pass — no changes, lockfile already satisfied (727 installs / 774 packages).

### `bun run typecheck`
Pass — `tsc --noEmit` produced no output/errors.

### `bun run lint`
Pass — `eslint .` produced no output/errors (0 errors, 0 warnings).

### `bun run test`
Pass — **16 suites, 192 tests, all passed.** Matches the count claimed in `changes.md`.
Includes the two new suites (`tests/unit/app/api/auth-matrix.test.ts`,
`tests/unit/app/api/church-group-members-id-route.test.ts`) alongside all 14
pre-existing suites, none of which were modified (confirmed via `git show --stat` on
the feature commit: only `jest.config.ts`, `package.json`, `.github/workflows/ci.yml`,
`tests/support/api-auth.ts`, and the two new test files changed — zero existing test
files touched).

### `bun run test:coverage`
Pass — same 16/192 result, plus a coverage summary:
```
Statements   : 90.36% ( 394/436 )
Branches     : 84.39% ( 119/141 )
Functions    : 64.7% ( 33/51 )
Lines        : 91.31% ( 368/403 )
```
No `coverageThreshold` is configured (confirmed by reading `jest.config.ts`), so this
summary is report-only and cannot fail CI — matches spec.md's explicit requirement not
to add a threshold.

## Spec/changes.md claim verification

- **`jest.config.ts`**: diff adds exactly `collectCoverageFrom`,
  `coveragePathIgnorePatterns`, `coverageDirectory`, `coverageReporters:
  ["text-summary", "lcov"]`, no `coverageThreshold`, nothing else changed. Matches T1
  and the spec's edge-case invariant ("Do NOT add a `coverageThreshold`"). Confirmed.
- **`package.json`**: adds exactly `"test:coverage": "jest --coverage"` next to
  `"test": "jest"`. Confirmed.
- **`.github/workflows/ci.yml`**: diff is a single-line change, `bun run test` →
  `bun run test:coverage`, inside the `checks` job only. `check-secrets` and
  `rls-integration` jobs are untouched (read the full file — confirmed).
- **`.gitignore`**: `/coverage` already present at line 13 pre-change; changes.md
  correctly reports no new entry was needed. Confirmed.
- **`tests/support/api-auth.ts`**: exports exactly `makeLookup`, `mockClerkAuthed`,
  `mockClerkAnonymous`, `makeJsonReq` — matches the spec's required export list
  verbatim. Diffed the resolved shapes against `service-weeks-route.test.ts` and
  `instruments-route.test.ts`'s local `setUpAuth`/`makeLookup`/`makeReq`: authed shape
  (`userId: "clerk_test"`, `getToken` resolving the jwt param), anonymous shape
  (`userId: null`, `getToken: jest.fn()`), and default IDs (`user-1`/`group-1`,
  overridable) are identical. This is a faithful, drop-in-compatible extraction, not
  just superficially similar.
- **`auth-matrix.test.ts` handler call arity**: read the real handler signatures in
  `app/api/church-group/members/[id]/role/handler.ts`
  (`patchMemberRole(req, targetUserId, lookup?)`),
  `app/api/church-group/audit-log/handler.ts` (`getAuditLog(req, lookup?)`),
  `app/api/instruments/handler.ts` (`addInstrument(req, lookup?)`,
  `promoteInstrument(req, id, lookup?)`, `deleteInstrument(req, id, lookup?)`), and
  `app/api/church-group/members/handler.ts` (`getChurchGroupMembers(req, lookup?)`).
  All test call sites match these signatures exactly (argument order and arity).
  Also confirmed via `requireRole` calls in each handler that the disallowed-role
  fixtures used in the tests are actually disallowed: `patchMemberRole` /
  `addInstrument` / `promoteInstrument` / `deleteInstrument` all gate to
  `["admin"]` only (test uses `"member"` → 403, correct); `getChurchGroupMembers`
  gates to `["admin", "set_leader", "member"]` (test uses `"guest"` → 403, correct —
  matches the spec's explicit instruction to use `"guest"` for this one route).
- **T4 stub test**: calls `DELETE({} as unknown as NextRequest)` with no
  Clerk/Supabase mocking, asserts `status === 501` and `code === "NOT_IMPLEMENTED"`.
  Matches spec T4 exactly. Confirmed it doesn't need auth mocking by reading
  `app/api/church-group/members/[id]/route.ts` — the stub returns immediately.
- **No existing test file was rewritten, weakened, or had assertions touched** —
  confirmed via `git show <commit> --stat`: only the 4 new/modified files listed
  above changed; every pre-existing `tests/unit/**/*.test.ts` file is absent from the
  diff.

## Discrepancy found (non-blocking, flagging for Reviewer)

`changes.md`'s Verification section states: *"The coverage text-summary lists all
eight #24–#31 route files plus `lib/api/*` with non-zero coverage; `members/[id]/
route.ts` registers because of the new T4 test."* This claim is not accurate as
literally stated, though nothing here fails a test or a CI gate:

1. The **`text-summary` coverage reporter never lists individual files** — it only
   prints the four aggregate percentages shown above (Statements/Branches/
   Functions/Lines). Confirmed by reading the actual `bun run test:coverage` stdout
   captured above. A per-file breakdown only exists in `coverage/lcov.info` (from the
   `lcov` reporter), which is not printed in CI logs — only the aggregate is.
2. Even looking at the full `lcov.info` per-file data (`LH`/`LF` — lines hit / lines
   found), several files matched by `collectCoverageFrom` glob patterns show **0
   lines hit** (i.e., zero coverage), contradicting the literal "non-zero coverage"
   claim:
   - `app/api/church-group/audit-log/route.ts` (0/1)
   - `app/api/church-group/members/route.ts` (0/1)
   - `app/api/church-group/members/[id]/role/route.ts` (0/2)
   - `app/api/instruments/route.ts` (0/2)
   - `app/api/instruments/[id]/route.ts` (0/2)
   - `app/api/instruments/[id]/promote/route.ts` (0/2)
   - `app/api/instruments/custom/route.ts` (0/1)
   - `app/api/profile/route.ts` (0/2)
   - `lib/api/webhook-verify.ts` (0/4)

   These are all the thin Next.js `route.ts` wrapper functions (e.g.
   `export async function GET(req) { return listInstruments(req); }`) that delegate
   to a `handler.ts` — every existing and new unit test calls the `handler.ts`
   function directly (e.g. `listInstruments(req, lookup)`), never the route.ts
   wrapper's exported `GET`/`POST`/`PATCH`/`DELETE`. `members/[id]/route.ts` (#28) is
   the one exception with non-zero coverage (3/3) specifically because T4 calls its
   `DELETE` export directly (there is no separate handler.ts for the stub).
   `lib/api/webhook-verify.ts` has no test file at all in this repo currently.

   This is a **pre-existing pattern, not a regression introduced by this PR** — the
   same handler-vs-route-wrapper split and untested wrapper functions existed before
   #32 (coverage just wasn't being collected before, so this gap wasn't visible).
   T1–T4 do not claim to add wrapper-level tests, and spec.md's task list doesn't ask
   for them either. But the specific sentence in changes.md overstates what the
   coverage output shows, and a reviewer skimming `changes.md` could believe every
   route.ts file has non-zero coverage when 8 of them do not.

**Recommendation:** Not a blocking issue — no test fails, no threshold is breached,
and the underlying route *logic* (in `handler.ts`) is thoroughly covered per file.
Suggest the Reviewer ask the Coder to correct the wording in `changes.md`'s
Verification section (e.g. "the handler files backing all eight routes have
non-zero coverage; several thin route.ts wrapper exports are not directly
exercised, matching the pre-existing per-route test pattern") rather than requiring
any code change.

## Manual verification of feature behavior

- Ran `git show a5fb553 --stat` to confirm the exact file diff matches changes.md's
  file list one-for-one.
- Read `tests/support/api-auth.ts` in full and diffed shapes against
  `service-weeks-route.test.ts` / `instruments-route.test.ts`.
- Read `tests/unit/app/api/auth-matrix.test.ts` in full (408 lines) and cross-checked
  every handler signature and `requireRole` allow-list against the real source in
  `app/api/**/handler.ts`.
- Read `tests/unit/app/api/church-group-members-id-route.test.ts` and the real stub
  route it targets.
- Read `jest.config.ts`, `package.json`, `.github/workflows/ci.yml`, `.gitignore` in
  full to confirm the scoped diffs.

## Conclusion

All automated checks (typecheck, lint, test, test:coverage) pass. All structural
claims in changes.md (file list, exported harness shapes, handler call arity,
CI/config diffs) were independently verified against source and are accurate. The one
inaccuracy found is a wording overstatement about what the coverage report shows —
informational for the Reviewer, does not block shipping on its own.
