# Review — Issue #67: Correct Pingram wire contract

## Verdict: NEEDS WORK

The #67 implementation itself matches the reviewed Pingram contract: outbound
dispatch uses `/sms` with the required payload, structured 200 errors fail,
webhook signatures include the tracking ID and use millisecond timestamps, and
SMS builders preserve links within the configured segment budget. Focused tests
cover the happy paths, invalid inputs, tampering, unknown events, and long
content.

The branch is not merge-ready because the required repository-wide test and
typecheck gates are failing. The failures are demonstrably outside the #67
diff: TypeScript 6 rejects the existing `baseUrl` configuration, and unrelated
fixtures across 17 suites are invalid under Zod v4 UUID validation. Resolve or
separately waive those repository-level regressions, then rerun this testing
and review stage.

Post-merge staging remains required: send one real SMS, confirm `trackingId`,
and verify a real callback's `X-Pingram-Id` is the tracking ID used in the
signature payload.
