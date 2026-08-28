# Test Results — Issue #67: Correct Pingram wire contract

## Verdict: FAIL — repository-wide gate is blocked outside this patch

### Passed

- Targeted #67 suite: **8 suites, 99 tests passed**.
- `bun run lint`: 0 errors (one pre-existing generated-coverage warning).
- `bun run check:workflows`: passed.
- `git diff --check`: passed.
- SMS source paths contain no non-ASCII characters or em dashes.

### Blocked checks

- `bun run typecheck` fails before source analysis because TypeScript 6 rejects
  the repository's deprecated `baseUrl` setting unless
  `ignoreDeprecations: "6.0"` is added to `tsconfig.json`.
- `bun run test` reports **17 failed / 70 passed suites** and **116 failed /
  1005 passed tests**. The failures are outside #67: fixtures used by many
  routes and schemas now return 400 under Zod v4's stricter UUID validation.
  The #67-focused suite passes, and this patch does not modify those fixtures
  or route handlers.

No unrelated fixture or TypeScript-config migration was made during this
issue-scoped testing stage.
