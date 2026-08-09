# Test Results — Issue #79: [Sprint 4] Conduct manual OWASP Top 10 review

## Overall: PASS (all mechanical checks green), with one non-blocking anomaly flagged for Review

All checks the coder claimed in `.pipeline/changes.md` were independently
re-run from a clean state in this worktree and confirmed. New tests were
also added to independently exercise edge cases the coder's own suite didn't
cover, and all pass. One structural anomaly (not a functional bug) was found
in `scripts/check-owasp-review.mjs` and is flagged below for the Reviewer's
judgment — it does not fail any check and does not block this report as PASS.

## Commands re-run independently

```
bun run lint            -> clean, no output (re-run twice, before and after adding tests)
bun run typecheck       -> clean, no output
bun run test            -> 111 suites / 1332 tests passed (110/1324 coder baseline
                            + 1 new suite / 8 new tests added by this stage)
bun run format:check    -> FAILS: 96 files, same file list/count on `origin/main`
                            (verified via a separate detached worktree checked out
                            at 3af534affcd5ee9487ab5e3475528dac21ffd982, the exact
                            merge-base) — confirmed PRE-EXISTING, not a regression.
                            None of the 6 files this issue touched/added appear in
                            the failing list.
bun run check:owasp     -> OK: OWASP review complete — 36 findings, 0 blocking.
bun run check:workflows -> OK: 1 workflow script(s) checked — syntax valid, all
                            agent() calls pinned. (sanity-check the CI edit didn't
                            break this unrelated guard)
bun audit --audit-level=high -> No vulnerabilities found (exit 0)
```

## Diff scope re-verified

`git diff <merge-base>...HEAD --stat` shows exactly: `.github/workflows/ci.yml`,
`README.md`, `documentation/owasp-top-10-review.md`, `package.json`,
`scripts/check-owasp-review.mjs`, `tests/unit/scripts/check-owasp-review.test.ts`
(plus `.pipeline/changes.md` and `.pipeline/spec.md`, written by earlier
pipeline stages). Nothing under `app/**`, `lib/**`, `schemas/**`, `supabase/**`,
or any pre-existing test differs from the merge-base — confirms the "docs +
tooling only" claim.

`package.json`/`.github/workflows/ci.yml`/`README.md` diffs individually
re-read and match the spec's exact required edits (new `check:owasp` script
entry after `check:git-secrets`; new CI step after `check:workflows`; new
two-line `README.md` paragraph after the `infrastructure-security.md`
paragraph, matching sentence style).

## New tests added by this stage

`tests/unit/scripts/check-owasp-review-tester-supplement.test.ts` (8 tests,
all pass) — independently exercises parsing edge cases named in
`.pipeline/spec.md` that the coder's own
`tests/unit/scripts/check-owasp-review.test.ts` didn't cover:

1. **Happy path / non-double-counting**: a full doc with a section-2
   scan-results table (header `Scan`, not `ID`) plus all 5 category sections
   parses to exactly 5 findings, 0 blocking — confirms the section-2 table is
   correctly invisible to the parser (not just "does the real doc pass").
2. **`### ` sub-headings don't terminate a `## ` section**: a fixture doc
   with `### Scope reviewed` / `### Method` / `### Findings` / `### Conclusion`
   sub-headings around each findings table (mirroring the real doc's
   structure) still parses successfully.
3. **Escaped-pipe handling**: a row whose `Summary` cell contains a literal
   `\|`-escaped grep command (mirroring the real doc's A03-1 row, which
   contains exactly this) parses to exactly 6 columns and exits 0.
4. **Wrong column count** (5 cells instead of 6): exits 1, names the category
   and a "column" message.
5. **ID-prefix mismatch** (an `A02-3` row inside the A01 section): exits 1,
   names the offending ID.
6. **FAILURE CASE**: a `Critical` + `Open` row (the most severe blocking
   combination, not covered by the coder's `High`+`Deferred` or `Low`+`Open`
   cases) exits 1 and names the ID, severity, and status.
7. **Empty-but-present doc**: exits 1 with an "empty" message.
8. **`cwd`-independence**: running the script with `cwd` set to `os.tmpdir()`
   and no path argument still resolves the real doc via
   `fileURLToPath(import.meta.url)` and exits 0 — confirms edge case 8 from
   the spec ("must resolve from the script's own location, not `cwd`").

## Independent fact-checking of the review document's claims

Per the spec's "Verify each claim yourself before writing it down" and the
coder's own "What the Tester should focus on" list, the following claims in
`documentation/owasp-top-10-review.md` were independently re-verified (not
just trusted from the doc's prose):

- `grep -rn "dangerouslySetInnerHTML" app lib components` -> 0 matches (doc's
  A03-4 claim confirmed).
- `grep -rn '\.query(\|sql\`\|SELECT \* FROM\|db\.raw\|pg\.query' app lib` ->
  0 matches (doc's A03-1 claim confirmed).
- `grep -n "poweredByHeader" next.config.ts` -> no match, i.e. genuinely
  absent (doc's A05-7 finding confirmed).
- `app/api/cron/invitation-reminders/route.ts` line 25 area -> confirmed
  `authHeader !== \`Bearer ${cronSecret}\`` (doc's A02-5/A07-5 finding
  confirmed, not fabricated).
- `lib/api/rate-limit.ts` -> confirmed module-level `const store = new Map(...)`
  (doc's A07-3 finding confirmed).
- `find . -iname "*.py"` / `requirements*.txt` / `pyproject.toml` / `Pipfile`
  / `setup.py` (excluding `node_modules`) -> 0 results (doc's pip-audit N/A
  claim confirmed).
- `bun audit --audit-level=high` -> re-run independently, "No vulnerabilities
  found", matches Section 2 row 1 exactly.

## Anomaly flagged for Review (non-blocking — does not fail any check)

`scripts/check-owasp-review.mjs`, as committed (`git show
HEAD:scripts/check-owasp-review.mjs`), contains **two literal NUL bytes**
(0x00) at byte offsets 1470 and 1483, inside the `splitRow` function's
`PLACEHOLDER` string literal:

```js
const PLACEHOLDER = "\x00ESCAPED_PIPE\x00";  // as actually committed
```

instead of the plainly-intended:

```js
const PLACEHOLDER = " ESCAPED_PIPE ";
```

(The `Read` tool and a plain terminal render these NUL bytes as if they were
spaces, which is presumably why this wasn't caught during implementation —
`cat -n`/most viewers don't visibly distinguish `\x00` from whitespace.)

**Effect confirmed by direct testing:**
- The script's *behavior* is unaffected — V8 strings permit embedded NUL
  characters like any other code unit, so `splitRow`'s escape/placeholder
  round-trip still works correctly (independently confirmed by the escaped-
  pipe test above, and by `bun run check:owasp` passing against the real
  doc, which contains an escaped-pipe row).
- `eslint` also parses the file as text and reports 0 errors/warnings (spot-
  checked directly with `eslint scripts/check-owasp-review.mjs`), so
  `bun run lint` is not silently skipping it.
- However, **`git` classifies the file as binary** because of the embedded
  NUL bytes: `git diff <merge-base>...HEAD -- scripts/check-owasp-review.mjs`
  shows `Binary files /dev/null and b/scripts/check-owasp-review.mjs differ`
  and `Bin 0 -> 6359 bytes` in `--stat`, instead of a normal unified diff.
  This means a human reviewer using plain `git diff`/`git show`, and very
  likely GitHub's own PR diff view, will **not see this file's 172 lines of
  new source at all** — it will render as "This file is not shown" — even
  though every other artifact (this report, `.pipeline/changes.md`) refers
  to it as ordinary readable source.

This is not a functional defect (nothing fails), but it does undermine the
Review stage's ability to "read... the actual diff" for this file as
AGENTS.md requires, since the normal diff view won't render it. Recommend
the Reviewer either (a) accept it as harmless and move on, having now read
the full source via this report and the `Read` tool (which does show the
content, NUL bytes notwithstanding), or (b) ask for a trivial one-line fix
(replacing the two `\x00` characters with literal spaces) before shipping,
since the fix is small, self-contained, and outside the "no code changes"
review-issue policy's application-code restriction (this is tooling, not
app/business logic).

## Conclusion

No failing tests. No regressions found. All of the coder's claimed
verification commands were independently re-run and matched. The one item
above is a packaging/readability anomaly, not a behavioral bug, and is
passed to Review for a judgment call per AGENTS.md's "green tests are not
the same as correct behavior" standard.
