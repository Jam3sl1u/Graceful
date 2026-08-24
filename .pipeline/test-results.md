# Test Results — Issue #142: Provision Google OAuth credentials & Cloudflare R2 bucket

This overwrites the stale `test-results.md` for issue #63 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: PASS (post-fix) — see "Post-review fix" note at bottom

Original Testing-stage run (below) found one failing test. The Reviewer
confirmed it as a genuine content defect (not a test bug) and it has since
been fixed; see the "Post-review fix" section at the end of this file for
the corrected result. The rest of this document is preserved as originally
written by the Testing stage.

## Verdict: FAIL — one failing test, pipeline paused for Reviewer

This issue is a docs-only deliverable (per spec.md's "Scope note" and
changes.md — no application code was touched). New tests were added at
`tests/unit/documentation/google-oauth-r2-provisioning-tester-supplement.test.ts`
to independently verify the runbook's content against the actual code it
describes (`lib/google-calendar/oauth.ts`, `lib/google-calendar/token-crypto.ts`,
`lib/r2/client.ts`, `app/api/google-calendar/callback/route.ts`), plus the
no-secrets / placeholder-integrity invariant the issue itself requires.

## Standard checks (re-run independently, not trusted from changes.md)

- `bun run lint` (eslint .) — clean, 0 errors.
- `bun run typecheck` (tsc --noEmit) — clean, 0 errors.
- `bun run test` (full suite, including new tests) — **78 suites total: 77
  passed, 1 failed. 983 tests total: 982 passed, 1 failed.** Before adding
  the new test file: 77 suites / 968 tests, all passing — matches the
  coder's claim in changes.md for the pre-existing suite exactly.
- `git diff origin/main...HEAD --stat` confirms only the claimed files
  changed: `.env.example`, `README.md`,
  `documentation/google-oauth-r2-provisioning.md` (new),
  `documentation/staging-environment.md`, plus `.pipeline/*.md` handoff
  files. No application code, tests, or CI workflows were touched.
- Grepped the diff for secret-shaped strings (`AIza`, `ya29.`, `GOCSPX`,
  `-----BEGIN`, `AKIA`, long opaque tokens) — none found. All Google
  Calendar/R2 placeholder lines in `.env.example` remain exactly `VAR=`
  (empty).

## New tests added (happy path / named edge cases / failure case)

File: `tests/unit/documentation/google-oauth-r2-provisioning-tester-supplement.test.ts`
(15 tests, Jest, matches this repo's `tests/unit/**/*.test.ts` layout and its
existing `-tester-supplement.test.ts` naming convention).

**Happy path:**
- Runbook exists and documents the real env vars consumed by
  `lib/google-calendar/oauth.ts` and `lib/r2/client.ts`.
- Runbook has a `## Verification checklist` section with `- [ ]` items.
- README links to the runbook; `staging-environment.md` cross-references it.

**Edge cases named in spec.md's "Edge cases / must-get-right details":**
- OAuth scope is exactly the write-only `calendar.events` URL, matching
  `oauth.ts`'s `CALENDAR_EVENTS_SCOPE`; any mention of `calendar.readonly`
  only appears as a "do not use this" caution, never as a recommendation.
- Redirect URI path is exactly `/api/google-calendar/callback` (fixed by
  the route file).
- `TOKEN_ENCRYPTION_KEY` documented as base64 (not hex), exactly 32 decoded
  bytes, generated via `openssl rand -base64 32`.
- Staging/production get distinct OAuth clients and encryption keys.
- R2 bucket must be private / no public access; API token scoped to a
  single bucket, not account-wide.
- R2 endpoint is the account-level shape
  (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`), no bucket in the
  host.
- `.env.example`'s nine Google Calendar / R2 placeholder lines remain
  exactly `VAR=` (empty) — no real values were introduced; only comment
  lines were added above the two blocks.

**Failure case (this is the one that FAILS):**
- A consistency check that the runbook's own claim in §6 — *"The ten
  variables provisioned by this runbook"* — matches the number of rows
  actually tabulated there.

## FAILING TEST — real content defect, not a test bug

```
● documentation/google-oauth-r2-provisioning.md › the 'ten variables' claim
  in §6 matches the actual number of variables tabulated

  expect(received).toBe(expected)
  Expected: 10
  Received: 9
```

**Root cause (verified by direct inspection, not just the failing test):**
`documentation/google-oauth-r2-provisioning.md` §6 says *"The ten variables
provisioned by this runbook:"* immediately above a table that lists only
**9** variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` (4 Google Calendar vars) +
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`, `R2_ENDPOINT` (5 R2 vars) = 9. This matches the actual
`.env.example` contents (also exactly 9 vars across the Google Calendar and
Cloudflare R2 blocks, confirmed by direct read of `.env.example` lines
34–50) and the env vars actually read by `lib/r2/client.ts` /
`lib/google-calendar/oauth.ts` / `lib/google-calendar/token-crypto.ts`.
There is no tenth variable anywhere in the codebase's Google
Calendar/R2 integration.

This traces back to `.pipeline/spec.md` itself, which independently says
"already has all ten variables as empty placeholders" (line 30) and "a
table mapping each of the ten variables" (line 117) — the miscount
originated in the planning stage and was faithfully carried into the
coding stage's runbook. It is a small but genuine factual inaccuracy in a
document whose whole purpose is to be an authoritative, followable runbook
for a human operator, and changes.md itself flagged "Runbook accuracy" as
something the Tester should specifically check.

Per AGENTS.md's pipeline contract ("A failing test pauses the pipeline for
review; it is not something this stage patches around"), this is not
something the Testing stage fixes. Flagging for the Reviewer/human: the
runbook's "ten variables" wording in §6 (its §1 intro doesn't state a
count, so that's unaffected) should be corrected to "nine" (or the
sentence reworded to avoid a count), and `.pipeline/spec.md`'s two "ten
variables" mentions carry the same latent error, worth fixing for
consistency if this pipeline stage is ever re-run from spec.md.

## Everything else: PASS

All other new assertions pass (14/15), and the pre-existing 77 suites /
968 tests are unaffected and still fully green. No secrets found anywhere
in the diff. `.env.example` placeholder integrity holds (all nine
Google Calendar/R2 vars still empty; only comment lines were added).
README and `staging-environment.md` cross-references are present and
correctly scoped (pointers only, no duplicated runbook content). Lint and
typecheck are both clean.

## Files added by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-142/tests/unit/documentation/google-oauth-r2-provisioning-tester-supplement.test.ts`

No implementation or documentation files were modified by this stage — the
one failing test surfaces a pre-existing defect in the coder's
`documentation/google-oauth-r2-provisioning.md`, it is not something this
stage patched around. Not ready for Review sign-off until the "ten
variables" discrepancy is resolved (either fix the wording or fix the
table — both should say the same number).

## Post-review fix

Per `review.md`'s verdict (NEEDS WORK, one MUST FIX): changed
`documentation/google-oauth-r2-provisioning.md` §6 "The ten variables
provisioned by this runbook:" to "The nine variables provisioned by this
runbook:" — matching the 9 rows actually tabulated. Also corrected the same
latent miscount in `.pipeline/spec.md` (lines 30 and 117, "ten" → "nine")
per the review's SHOULD FIX, so a future re-run from spec.md doesn't
reintroduce it.

Re-ran the full suite after the fix:

```
Test Suites: 78 passed, 78 total
Tests:       983 passed, 983 total
```

`bun run lint` and `bun run typecheck` both clean, 0 errors. All 15 tests in
`tests/unit/documentation/google-oauth-r2-provisioning-tester-supplement.test.ts`
now pass, including the previously-failing "ten variables" consistency
check. No other files changed. Ready to ship.
