# Review — Issue #142: Provision Google OAuth credentials & Cloudflare R2 bucket

## VERDICT: NEEDS WORK

One real, well-localized factual error in the authoritative runbook, surfaced
by a legitimate failing test. Everything else is sound. This is a one-word
documentation fix, not a design or security problem — hence NEEDS WORK, not
BLOCK.

## What I verified firsthand (not just trusting the summaries)

- Ran `git diff main...HEAD` and read every changed file directly.
- Confirmed the scope framing: this is a provisioning/ops issue whose only
  legitimate in-repo deliverable is a human-operator runbook plus link wiring.
  No application code was touched. Correct call.
- Counted the real integration env vars against source, not the summaries:
  `lib/google-calendar/oauth.ts` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI`), `lib/google-calendar/token-crypto.ts`
  (`TOKEN_ENCRYPTION_KEY`), `lib/r2/client.ts` (`R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`).
  That is exactly **nine** variables. `.env.example` also lists exactly nine.
  There is no tenth variable anywhere in the Google Calendar / R2 integration.
- Runbook technical accuracy checks out: OAuth scope is write-only
  `calendar.events` only (no read scope), redirect path is exactly
  `/api/google-calendar/callback`, `TOKEN_ENCRYPTION_KEY` is base64 / exactly
  32 decoded bytes via `openssl rand -base64 32`, R2 bucket must be private,
  R2 endpoint is the account-level `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
  shape. All match the code.
- `.env.example` edit is comment-only; all nine placeholder lines remain
  exactly `VAR=` (empty). No secrets anywhere in the diff. README and
  `staging-environment.md` cross-references are minimal pointers, not
  duplicated content.
- The tester's new test file is meaningful, not superficial: it reads the
  actual committed files and cross-checks them against the code and the
  no-secrets invariant. The failing test is honest — it is not a test bug.

## Must fix (blocking the SHIP)

1. `documentation/google-oauth-r2-provisioning.md` line 110: the sentence
   **"The ten variables provisioned by this runbook:"** sits directly above a
   table that lists **nine** variables. There is no tenth variable in the
   codebase, `.env.example`, or the table. Change "ten" to "nine" (or reword
   to drop the count). This is the single failing test and a genuine accuracy
   defect in a document whose entire purpose is to be a followable, correct
   operator runbook — an operator would waste time hunting for a nonexistent
   tenth variable.

## Should fix (same root miscount, for consistency)

2. `.pipeline/spec.md` carries the same latent error at line 30 ("already has
   all ten variables as empty placeholders") and line 117 ("a table mapping
   each of the ten variables"). The planner introduced the miscount; the coder
   faithfully copied it. Correct these to "nine" too so a re-run from spec does
   not reintroduce the defect. (Spec is a handoff artifact, so this is
   secondary to fix #1, but it is the actual source.)

## Process note (not blocking, for the human/orchestrator)

- The tester's test file `tests/unit/documentation/
  google-oauth-r2-provisioning-tester-supplement.test.ts` is currently
  **untracked**, and `.pipeline/test-results.md` is **modified but
  uncommitted**. Whoever applies fix #1 should also stage/commit the test file
  so the failing-then-passing test travels with the change; otherwise the PR
  would ship the doc without the test that guards it.

## After the fix

Once "ten" → "nine" is corrected and the suite is green (the consistency test
is written to pass when the count is not claimed as ten, or when the table has
the claimed number of rows), this is a clean, correctly-scoped, secret-free
docs deliverable that satisfies the issue. Re-run `bun run test` to confirm
78 suites / all green, then this is SHIP-able.
