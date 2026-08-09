# Changes — Issue #79: [Sprint 4] Conduct manual OWASP Top 10 review

## Summary

Implemented exactly what `.pipeline/spec.md` specified: the manual OWASP Top
10 (2021) review document (A01, A02, A03, A05, A07), a mechanical launch-gate
script that parses it, a test suite for that script, and the three small
wiring changes (`package.json`, CI, `README.md`). This is a docs +
tooling-only issue — no application/business-logic code was touched, per the
spec's "Code changes: none (default)" policy, because no finding rated
`Critical` or `High` was found.

## Files added

- **`documentation/owasp-top-10-review.md`** — the primary deliverable. Nine
  required sections (verbatim headings per spec), covering:
  - Section 1: scope (A01/A02/A03/A05/A07 in scope; A04/A06/A08/A09/A10 and
    pen-testing explicitly out of scope), commit SHA (`3af534affcd5ee9487ab5e3475528dac21ffd982`)
    and date reviewed, and the launch-gate policy (enforced by `bun run
    check:owasp`).
  - Section 2: the actual `bun audit --audit-level=high` run (clean, exit 0)
    and `pip-audit` recorded `N/A` with evidence (zero `.py` files /
    `requirements*.txt` / `pyproject.toml` / `Pipfile` / `setup.py` anywhere
    in the repo, verified by `find`).
  - Sections 3–7: one category each, every candidate item named in the spec
    addressed as its own findings-table row (36 total rows across the five
    categories — none `Critical`/`High`-and-not-`Resolved`, none `Open`).
  - Section 8: consolidated non-`Resolved` findings (6 rows: two `Low`/`Accepted`,
    four `Medium`/`Low` `Deferred`).
  - Section 9: operator re-run checklist, including the human Phase 1
    launch sign-off (#83) as an explicit checklist item.

  **Six open (non-`Resolved`) findings recorded**, all `Low`/`Medium` and
  intentionally not fixed in this review-only issue (per its "Code changes"
  scope — only `Critical`/`High` may be fixed here, and none were found):
  - `A01-7`/`A05-5`: `app/api/_examples/admin-only/**` ships in the
    production API surface (`Accepted` — still auth-gated, no sensitive
    data; recommended cleanup, not fixed).
  - `A02-5`/`A07-5`: the cron route's `CRON_SECRET` bearer check
    (`app/api/cron/invitation-reminders/route.ts:25`) uses `!==` instead of
    a constant-time comparison (`Deferred` — recommend `crypto.timingSafeEqual`
    as a follow-up).
  - `A05-7`: `next.config.ts` doesn't set `poweredByHeader: false`
    (`Deferred` — trivial follow-up).
  - `A07-3`: the rate-limit store (`lib/api/rate-limit.ts`) is an in-memory
    `Map`, not distributed across serverless instances, even though
    `@upstash/redis`/`@upstash/qstash` are already repo dependencies
    (`Deferred` — recommend migrating the store as a follow-up).

  None of these block `bun run check:owasp` — the gate only fires on
  `Critical`/`High`-and-not-`Resolved` or any `Open` finding, and there are
  none of either.

- **`scripts/check-owasp-review.mjs`** — the launch-gate script (AC4). Copies
  the shape of `scripts/check-service-role.mjs` (`#!/usr/bin/env node`, ESM,
  `node:fs`/`node:path`/`node:url` only, `REPO_ROOT`/default-doc-path
  resolution via `fileURLToPath(import.meta.url)`, not `cwd`). Parses the
  five required category sections (bounded by `## ` headings; `### `
  sub-headings do not end a section), finds the findings table whose header
  row's first cell is exactly `"ID"` (so the Section 2 scan table and
  Section 8's consolidated table are invisible to it), and fails with a
  specific message for each of the 7 violation classes named in the spec
  (missing doc, missing category, missing/empty table, wrong column count,
  invalid `Severity`/`Status`, ID-prefix mismatch, and the blocking-finding
  gate itself). Prints `OK: OWASP review complete — N findings, 0 blocking.`
  on success. `node scripts/check-owasp-review.mjs [pathToReviewDoc]` — the
  optional arg is what the Jest test uses to point at fixture files.

- **`tests/unit/scripts/check-owasp-review.test.ts`** — subprocess-based
  tests copying `tests/unit/scripts/check-git-secrets.test.ts`'s pattern
  (`spawnSync`, `fs.mkdtempSync(os.tmpdir())` fixtures, cleanup in
  `afterEach`). Covers every case the spec named as a minimum: a minimal
  well-formed doc (exit 0), the real doc via default path resolution (exit
  0), a doc missing the A05 section (exit 1, stderr names A05), a
  `High`+`Deferred` row (exit 1, names the finding ID), a `Low`+`Open` row
  (exit 1 — Open blocks at any severity), a lowercase `"high"` Severity
  (exit 1), a category whose table has zero data rows (exit 1), and a
  nonexistent doc path (exit 1).

## Files modified

- **`package.json`** — added `"check:owasp": "node scripts/check-owasp-review.mjs"`
  immediately after `"check:git-secrets"`.
- **`.github/workflows/ci.yml`** — added `- run: bun run check:owasp` in the
  `checks` job, immediately after the existing `- run: bun run
  check:workflows` step. No other job touched.
- **`README.md`** — added a two-line paragraph under `## Environments`,
  immediately after the existing `infrastructure-security.md` paragraph,
  linking `documentation/owasp-top-10-review.md`, matching the existing
  sentence style.

## Verification run (all from a clean state, in this worktree)

```
bun run lint          -> clean (no output/errors)
bun run typecheck     -> clean (no output/errors)
bun run test          -> 110 suites / 1324 tests passed (includes the new
                          tests/unit/scripts/check-owasp-review.test.ts)
bun run format:check  -> FAILS, but pre-existing and unrelated to this issue:
                          96 files fail, identical count/file-list whether or
                          not this issue's changes are stashed (verified by
                          `git stash -u` + re-running). None of the 6 files
                          this issue touched/added appear in that list — the
                          new doc and script are themselves Prettier-clean.
bun run check:owasp   -> OK: OWASP review complete — 36 findings, 0 blocking.
bun run check:workflows -> OK: 1 workflow script(s) checked — syntax valid,
                          all agent() calls pinned. (sanity-check that the
                          CI edit didn't break this unrelated guard)
bun audit --audit-level=high -> No vulnerabilities found (exit 0)
```

## What the Tester should focus on

1. **`scripts/check-owasp-review.mjs`'s parsing correctness** is the highest-risk
   surface — it's hand-written markdown/table parsing, not a library. Worth
   independently verifying:
   - `### ` sub-headings genuinely don't terminate a `## ` section (the doc's
     own category sections rely on this — each has `### Scope reviewed` /
     `### Method` / `### Findings` / `### Conclusion` sub-headings).
   - The Section 2 scan-results table and Section 8 consolidated table are
     correctly *not* double-counted (Section 2's header starts with `Scan`,
     Section 8 lives outside the five category section boundaries entirely).
   - A row's `Summary`/`Evidence`/`Resolution` cells in the real doc contain
     backticks, parentheses, and em dashes but no literal unescaped `|` —
     worth a final grep (`grep -n '[^\\]|' documentation/owasp-top-10-review.md`
     inside table rows, being careful of the table delimiters themselves)
     to confirm none slipped in during drafting.
2. **The real doc parses clean today** (`bun run check:owasp` exits 0 with 36
   findings) — worth confirming this stays true after any Prettier
   reformatting of the table (table cell reflow shouldn't change parsed
   content, but it's worth one more run post-format).
3. **`bun audit` and the `pip-audit` N/A claim** were both actually run/verified
   for this PR (not fabricated) — the Tester should independently re-run
   `bun audit --audit-level=high` and the `find` commands for Python tooling
   to confirm the same clean/N/A result rather than trusting the doc's prose.
4. **The `format:check` pre-existing failure** (96 files, none touched by this
   issue) — confirm independently via `git stash` that it predates this
   branch, so it isn't mistaken for a regression introduced here.
5. **No application/business-logic code changed** — the diff should be
   entirely `documentation/**`, `scripts/check-owasp-review.mjs`,
   `tests/unit/scripts/check-owasp-review.test.ts`, `package.json`,
   `.github/workflows/ci.yml`, and `README.md`. Nothing under `app/**`,
   `lib/**`, `schemas/**`, `supabase/**`, or existing tests should differ
   from `origin/main` (other than `.pipeline/spec.md`, which the Planning
   stage wrote before this stage started).
