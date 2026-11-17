# Changes — Issue #82 (remediation re-run)

## Single doc edit
`documentation/staging-environment.md`, §7.1 item 1 (formerly lines 163-164, now 163-169): replaced the stale sentence "`resetDisposablePersona` hard-guards against ever touching `FIXTURE.churchGroupId`" with the actual guards, matching `tests/e2e/support/fixtures.ts` `resetDisposablePersona`:
- throws if the persona resolves to `FIXTURE.adminUserId` / `FIXTURE.memberUserId`;
- throws if the persona is an admin of `FIXTURE.churchGroupId`;
- a disposable persona's member/guest row inside the fixture group is deleted.

## Not changed
No test, fixture, CI, config, or product code changed in this run.

## Verification
lint, typecheck clean; Jest 147 suites / 3144 tests pass; `playwright test --list` = 15 tests in 11 files.

## Status of AC 5
None of the issue #82 E2E assertions has run against staging. AC 5 is still pending the human provisioning `E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` (Clerk test users + GitHub secrets).

## Found but not fixed
Nothing.
