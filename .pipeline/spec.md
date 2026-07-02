# Spec: Issue #12 — [Sprint 0] Set up CI pipeline skeleton

## OPEN QUESTIONS

**None that block coding.** One decision was already made for you and one item
is out of scope for a code change — read both before starting:

1. **`npm` vs `bun`.** The issue text says `npm audit` / Jest / ESLint / `tsc`,
   but this repo is a **bun** project: it has `bun.lock` (no `package-lock.json`),
   and `.claude/settings.json` standardizes on `bun` commands. The existing
   `.github/workflows/ci.yml` already uses `bun`. **Follow the repo — keep bun.**
   Do NOT convert the workflow to npm. The acceptance criteria (type errors,
   lint, tests, dependency audit run on every PR) are satisfied by the bun
   equivalents.

2. **"PR blocked from merging if any step fails"** is a GitHub **branch
   protection / required-status-check** setting on the repo, configured through
   the GitHub UI or API — it is **not** something that lives in a file in this
   repo. It is out of scope for the Coder. Do not attempt to encode it in the
   workflow. (Note it in the PR description so a human enables the required
   check named `checks` on `main`.)

---

## 1. Summary

Issue #12 is **already ~95% implemented** on this branch. `.github/workflows/ci.yml`
exists and already:

- triggers on `pull_request` (every PR),
- installs deps with a frozen lockfile,
- runs `bun run typecheck` (`tsc --noEmit`), `bun run lint` (ESLint),
  `bun run test` (Jest), and `bun audit --audit-level=high`.

All four `package.json` scripts it depends on exist (`typecheck`, `lint`,
`test`). The lockfile (`bun.lock`), `eslint.config.mjs`, `jest.config.ts`, and
`tsconfig.json` all exist.

**The Coder's job is small and surgical.** Do the verification/hardening items
in §3. Do NOT rewrite the workflow from scratch, do NOT switch package managers,
do NOT add deploy/E2E steps.

---

## 2. Current file state (already on branch — do not recreate)

Existing `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - run: bun run typecheck

      - run: bun run lint

      - run: bun run test

      - run: bun audit --audit-level=high
```

Relevant `package.json` scripts (present, do not change):
`"lint": "eslint ."`, `"typecheck": "tsc --noEmit"`, `"test": "jest"`.

---

## 3. Required changes

Modify **only** `/Users/jamesliu/Documents/Graceful/.github/workflows/ci.yml`.
Apply these hardening edits to the existing file (keep the bun toolchain):

1. **Pin the workflow to a concurrency guard** so redundant runs on rapid
   pushes to a PR are cancelled (keeps runs fast/cheap, supports the
   "~under 5 minutes" criterion). Add at the top level (after `on:`):

   ```yaml
   concurrency:
     group: ci-${{ github.ref }}
     cancel-in-progress: true
   ```

2. **Pin `bun-version` to a fixed minor** instead of `latest`, so CI is
   reproducible and a new bun release can't break the pipeline unexpectedly.
   Use a concrete recent version, e.g.:

   ```yaml
       - uses: oven-sh/setup-bun@v2
         with:
           bun-version: 1.2.x
   ```

   (If you cannot confirm a valid `1.2.x` tag resolves, fall back to `1.2`.)

3. **Verify `bun audit --audit-level=high` is a valid invocation** for the bun
   version being used. `bun audit` and its `--audit-level` flag exist in modern
   bun. **If — and only if — you confirm the flag is unsupported** by the pinned
   version, replace that single step with:

   ```yaml
       - run: bun audit --audit-level=high
   ```
   staying as-is is preferred; do not silently drop the audit step. The audit
   MUST remain and MUST be gated at `high` per PRD §16. Do not lower it to
   `low`/`moderate` (that reintroduces the noise the issue explicitly avoids).

4. **Do not add `continue-on-error` to any step.** Every step must be able to
   fail the job — that is the whole point (broken code can't merge).

5. Keep the job name as `checks` (this is the status-check name a human will
   mark "required" in branch protection — keep it stable and predictable).

If any of items 1–2 are judged unnecessary polish and the reviewer prefers
minimalism, item 1 (concurrency) and item 4 (no continue-on-error) are the
non-negotiable correctness items; item 2 is a reproducibility nicety.

---

## 4. Edge cases the implementation must handle

- **Frozen lockfile drift:** `bun install --frozen-lockfile` fails if
  `bun.lock` is out of sync with `package.json`. This is desired behavior
  (catches un-committed lockfile changes) — keep `--frozen-lockfile`, do not
  weaken it to a plain `bun install`.
- **Empty/minimal test suite:** Jest exits non-zero when it finds zero test
  files by default. If the current codebase has no test files, the `bun run test`
  step will FAIL and block the workflow, contradicting the "empty/minimal
  codebase completes" criterion. Confirm whether test files exist; if none do,
  ensure the `test` script tolerates no tests by passing `--passWithNoTests`
  (Jest flag) — check `jest.config.ts` / the `test` script first and add the
  flag only if there are currently no tests. Do not add test files (out of
  scope). Prefer adding `--passWithNoTests` in the `package.json` `test` script
  so both CI and local runs behave identically.
- **Audit step false-positives:** transitive high-severity advisories with no
  fix available could block all PRs. Do not pre-emptively suppress; leave the
  gate at `high`. Handling a specific unfixable advisory is a future issue, not
  this one.

---

## 5. Patterns to follow

- The existing `.github/workflows/ci.yml` on this branch **is** the pattern —
  edit it in place rather than introducing a differently-structured workflow.
- Toolchain convention comes from `.claude/settings.json` (bun-based) and the
  presence of `bun.lock`. Match it.

---

## 6. Explicitly OUT OF SCOPE (do not touch)

- Playwright / E2E in CI (the `test:e2e` script exists but must NOT be added to
  this workflow — deferred to a later sprint per the issue).
- Any staging/deploy gate (issues #13 / #83).
- Branch-protection / required-status-check configuration (GitHub setting, not a
  repo file). Mention in the PR body; do not implement.
- Any change to `tsconfig.json`, `eslint.config.mjs`, `jest.config.ts`,
  application/source code, or dependencies beyond the `--passWithNoTests` note
  above.
