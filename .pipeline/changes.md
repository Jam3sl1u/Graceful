# Changes for Issue #12 — CI pipeline skeleton hardening

## File changed

- `.github/workflows/ci.yml` (only file touched, per spec §3/§6)

## What changed

1. Added a top-level `concurrency` block right after `on:`:
   ```yaml
   concurrency:
     group: ci-${{ github.ref }}
     cancel-in-progress: true
   ```
   Cancels redundant in-flight runs when new commits land on the same PR/ref,
   keeping CI fast/cheap.

2. Pinned `bun-version` in the `oven-sh/setup-bun@v2` step from `latest` to
   `1.2.x` for reproducibility (confirmed `1.2.x` tags exist upstream, e.g.
   `bun-v1.2.23`, so the range resolves).

## What was verified but left unchanged (per spec)

- `bun audit --audit-level=high` — confirmed valid/supported on bun 1.3.4
  (locally installed); left as-is, gate stays at `high`.
- `package.json` `test` script (`jest`, no `--passWithNoTests`) — left
  unchanged because real test files already exist
  (`tests/unit/lib/api/response.test.ts`), so Jest does not need the
  no-tests fallback flag.
- Job name kept as `checks` (stable name for future branch-protection
  required-status-check setup — out of scope, a human must enable it in
  GitHub settings on `main`).
- No `continue-on-error` added to any step — every step can still fail the
  job.
- No changes to `tsconfig.json`, `eslint.config.mjs`, `jest.config.ts`,
  `package.json`, or application/source code.

## Local verification performed (mirrors the workflow steps)

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — YAML parses.
- `bun install --frozen-lockfile` — passes, no lockfile drift.
- `bun run typecheck` (`tsc --noEmit`) — passes, no errors.
- `bun run lint` (`eslint .`) — passes, no errors.
- `bun run test` (`jest`) — passes, 1 suite / 3 tests green.
- `bun audit --audit-level=high` — runs cleanly, exit 0, no high/critical advisories.

## What the Tester should focus on

- Confirm the workflow YAML is syntactically valid and the diff matches the
  spec's §3 requirements exactly (concurrency block, pinned bun-version,
  audit step untouched, no `continue-on-error`, job name `checks` preserved).
- Confirm no other files were modified (spec explicitly restricts scope to
  `.github/workflows/ci.yml`).
- Note for PR description (not implemented, per spec §OPEN QUESTIONS #2 and
  §6): a human must configure branch protection on `main` to require the
  `checks` status check before merge.

## Commit

- `c8539d4` — "Harden CI workflow for issue #12" on branch
  `issue-12-sprint-0-set-up-ci-pipeline-skeleton`.
