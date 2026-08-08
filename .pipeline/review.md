# Review — Issue #79: [Sprint 4] Conduct manual OWASP Top 10 review

VERDICT: NEEDS WORK

## Summary

The primary deliverable is genuinely good. I independently spot-checked the
review document's load-bearing claims against the actual source rather than
trusting its prose, and every one I checked held up (details below). The gate
script, its tests, and the three wiring edits all match the spec. The tests are
real subprocess tests with real fixtures and real exit-code assertions — not
superficial.

Three things must be fixed before a human sees this PR. None is a security
regression; two are integrity problems with the deliverable itself (a diff a
human cannot read, and a gate that fails open), and one is lost work.

## What I verified independently (all confirmed)

- A01-1's "28 handler.ts modules": `find app/api -name handler.ts | wc -l` = 28,
  and all 28 match `requireAuth|requireRole`. Zero unprotected handlers. Claim exact.
- A02-5 / A07-5: `app/api/cron/invitation-reminders/route.ts:25` really does
  compare the bearer header with `!==`. Not fabricated.
- A02-5's mitigation claim: `resolveTier` really does map
  `/api/cron/invitation-reminders` to `sms`, and `sms` really is
  `{ limit: 5, windowMs: 60_000 }` (`lib/api/rate-limit.ts:40,73`).
- A02-3: `SIGNED_URL_EXPIRY_SECONDS = 30 * 60`, passed to both signers.
- A05-7: `poweredByHeader` is genuinely absent from `next.config.ts`.
- A07-3: `const store = new Map(...)` at `lib/api/rate-limit.ts:123`. Confirmed.
- A07-4: the `x-forwarded-for` trust-boundary comment really is in the source.
- A03-1 / A03-4: re-ran both greps; zero matches each.
- Wiring diffs (`package.json`, `.github/workflows/ci.yml`, `README.md`) match
  the spec's required edits in placement and style.
- The doc, the script, and the coder's test file are all Prettier-clean.

## Must fix

### 1. `scripts/check-owasp-review.mjs` contains two raw NUL bytes, so git treats the file as binary

Confirmed firsthand, not just taken from `.pipeline/test-results.md`:

- `git show HEAD:scripts/check-owasp-review.mjs | od -c` shows two 0x00 bytes
  inside the `PLACEHOLDER` string literal on line 30.
- `git diff main...HEAD --stat` reports
  `scripts/check-owasp-review.mjs | Bin 0 -> 6359 bytes`.

Line 30 is committed with literal 0x00 bytes rather than escape sequences.
Behavior is unaffected, but the consequence is that the **only new executable
file in this PR — the script that gates the Phase 1 launch — renders as an
unreadable binary blob in `git diff`, `git show`, and GitHub's PR diff view.**
A human reviewer will never see its 189 lines. That defeats the point of
shipping a reviewable gate.

Fix: replace each of the two raw NUL bytes in that string literal with the
six-character JavaScript escape sequence `\u0000` (backslash, u, 0, 0, 0, 0),
so line 30 reads:

    const PLACEHOLDER = "\u0000ESCAPED_PIPE\u0000";

This is behavior-identical — the runtime string is unchanged, so the sentinel
keeps its collision resistance — but the source file becomes plain ASCII.
Re-verify afterwards that
`git diff main...HEAD -- scripts/check-owasp-review.mjs` renders as a normal
unified diff.

### 2. The gate fails open when a category section has more than one findings table

`findFindingsTable()` (`scripts/check-owasp-review.mjs:52-75`) returns on the
**first** table whose header first cell is `ID` and ignores every later one in
the same section. I demonstrated the fail-open with a fixture containing, inside
the A01 section, a clean first table followed by a second table holding
`| A01-9 | Critical | Open | RCE in prod | ... |`. Result:

    OK: OWASP review complete — 5 findings, 0 blocking.   exit=0

A `Critical` + `Open` finding sits in the document and the launch gate reports
zero blocking. For a gate whose entire job is to fail closed, silently skipping
rows is the wrong default — and it is a plausible future edit (someone splits a
category into "resolved" and "open" tables). The spec's parsing note says "Only
parse **tables** whose header row's first cell is exactly `ID`" (plural), so this
is also a spec deviation, not just a judgment call.

Fix in `scripts/check-owasp-review.mjs`: collect **all** ID-headed tables within
a section and validate the union of their data rows (or, on the stricter
reading, treat "more than one ID table in a category section" as its own
violation). Add a test to `tests/unit/scripts/check-owasp-review.test.ts` for
the fixture above — a second table with a `Critical`/`Open` row must exit 1.

### 3. The testing stage's work is uncommitted and will be lost

`git status --short` shows `.pipeline/test-results.md` modified and
`tests/unit/scripts/check-owasp-review-tester-supplement.test.ts` untracked.
The 8 supplemental tests pass (I ran `bun run test tests/unit/scripts/`:
3 suites, 25 tests green) but neither the tests nor the report is in the commit.
Commit both.

Also: that supplement file is **not** Prettier-clean — it takes `format:check`
from 96 pre-existing failures to 97. CI does not run `format:check`, so this
will not break the build, but it is a new failure attributable to this branch,
and `.pipeline/test-results.md`'s "none of the files this issue touched appear
in the failing list" becomes inaccurate once that file is committed. Run
`bunx prettier --write` on it before committing.

## Should fix (document accuracy — this doc is a security record)

### 4. A02-4 overstates token entropy

The doc says the invitation `response_token` has "**256 bits of randomness**".
It is two `crypto.randomUUID()` v4 values concatenated
(`app/api/invitations/handler.ts:55`). UUIDv4 fixes 6 bits for version+variant,
so this is **244 bits of entropy** in a 256-bit (64-hex-char) representation.
Still far beyond adequate — but a security review document should not round
entropy up. Change to "244 bits of entropy (two UUIDv4s, 122 bits each) in a
64-hex-char column".

### 5. A02-4 omits expiry, which the spec explicitly asked it to assess

The spec named "entropy, expiry, single-use" for the response-token row. The doc
covers entropy and single-use but says nothing about expiry. Expiry does exist —
`invitations.response_deadline`, with `accept_invitation`/`deny_invitation`
raising `EXPIRED` and `get_invitation_by_token` computing an `expired` status —
but every check is guarded by `response_deadline IS NOT NULL`
(`20260712000002_get_invitation_by_token_rpc.sql:63`) and the column is
nullable. An invitation created with a NULL deadline carries a bearer token that
never expires. Add a sentence to A02-4 covering the expiry mechanism and this
NULL case (Info/Low is a fine severity — do not inflate it).

## Not blocking, noted for the record

- The gate's policy is unenforceable by construction: whoever writes the doc
  chooses each finding's `Severity` and `Status`, so `check:owasp` proves the
  document is internally consistent, not that the review was honest. The spec is
  aware of this ("do not downgrade a severity to make the check pass"). Nothing
  to fix; the human sign-off in #83 is the real control.
- The "no application-code changes" policy was honored — the diff touches only
  `documentation/`, `scripts/`, `tests/`, `package.json`,
  `.github/workflows/ci.yml`, `README.md`. Nothing under `app/**`, `lib/**`,
  `schemas/**`, `supabase/**`. Confirmed.
- `format:check`'s 96 pre-existing failures are genuinely pre-existing and out
  of scope for this issue.

## Re-review scope

Items 1, 2, and 3 are required. Items 4 and 5 are one-line documentation edits
and should ride along. After the fix, re-run `bun run check:owasp`,
`bun run test`, and confirm
`git diff main...HEAD -- scripts/check-owasp-review.mjs` renders as text.
