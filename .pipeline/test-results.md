# Test Results — Issue #82 (remediation re-run)

Verdict: PASS (for everything verifiable locally). AC 5 is NOT verified.

## Independently re-run (Bun)
- `bun run lint`: clean
- `bun run typecheck`: clean
- `bun run test` (Jest): 147 suites, 3144 tests, all pass (matches coder's claim and spec)
- `bunx playwright test --list`: 15 tests in 11 files (matches spec)

## Doc-vs-code check
Compared `documentation/staging-environment.md` section 7.1 item 1 against `resetDisposablePersona` in `tests/e2e/support/fixtures.ts`. The doc now matches the code on all three behaviors:
- throws if the persona resolves to `FIXTURE.adminUserId` / `FIXTURE.memberUserId`
- throws if the persona is an admin of `FIXTURE.churchGroupId`
- deletes a disposable member/guest row inside the fixture group, or the owned group otherwise

The stale "hard-guards against ever touching FIXTURE.churchGroupId" sentence is gone.

## Scope check
`git status` shows only `.pipeline/spec.md` modified in the working tree. The doc edit is already committed (e7d2a38), and no test, fixture, CI, or product code changed in this run.

## Not verified
No issue #82 E2E assertion has run against staging, because `E2E_SETUP_ADMIN_EMAIL` and `E2E_GUEST_EMAIL` and the matching secrets are not provisioned. `test:e2e` was deliberately not run, since the affected tests would skip and prove nothing. AC 5 remains pending human action.

No new tests were written. The change is documentation-only and the spec forbids test changes.
