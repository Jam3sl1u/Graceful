# Spec — Issue #82: [Sprint 4] Full E2E regression pass across all Phase 1 critical paths (re-run after remediation commit b08a3e1)

## RESOLVED OPEN QUESTION — OQ1 (operator decision, 2026-11-16)

*Carried forward verbatim from the previous spec (commit 17f0988). Do not
delete this section.*

The human operator answered OQ1 in chat on 2026-11-16 by picking an option in
an interactive question. They chose **Option A (Recommended)**: disposable test
users.

- The operator will create two throwaway staging sign-in accounts.
- The operator will add `E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` as GitHub
  Actions secrets.
- Until then, the two tests that need them skip themselves.

Option B, simulating create-group/join/guest-claim with service-role writes,
was not chosen.

**There are no new OPEN QUESTIONS.** The pipeline may proceed.

## Current state (verified in this worktree, not assumed)

Every acceptance criterion that code can satisfy is already implemented in
ef31bd1 + b08a3e1. **Do not recreate or rewrite any of the following.**

| AC | Where it lives | Status |
| --- | --- | --- |
| 1. #52 and #66 suites run together against one staging deploy | `playwright.config.ts` (`testDir: ./tests/e2e`, `workers: 1`); `.github/workflows/ci.yml` `e2e` job makes a single `bun run test:e2e` call; `documentation/staging-environment.md` §7.2 | Done |
| 2. Continuous admin week-setup flow | `tests/e2e/week-setup-flow.spec.ts` | Done |
| 3. Notification + inbox flow | `tests/e2e/notification-inbox.spec.ts` | Done |
| 4. Guest invitation, existing-user and new-user paths | `tests/e2e/guest-invitation.spec.ts`, Test A and Test B | Done |
| 5. All tests pass against staging in a single CI run | Blocked on the human provisioning the two Clerk personas and secrets (OQ1). The pipeline cannot verify this. | Pending human action |

### Previous review findings (`.pipeline/review.md`, BLOCK on ef31bd1) are all fixed in b08a3e1 / 17f0988

I checked each fix against the source:

- **B1.** `guest-invitation.spec.ts:162-180`: the same-session re-claim now
  asserts 201 + `alreadyClaimed` / `invitationId` / `guest.userId`, and an
  unknown but schema-valid token asserts exactly 404. Verified against:
  - `supabase/migrations/20260805000001_guest_invitation_flow.sql`: step 2
    NOT_FOUND at line 122; step 4 idempotent return at lines 128-139, which
    runs before the step-6 ALREADY_CLAIMED raise at line 151 and the step-7
    NOT_CLAIMABLE check.
  - `app/api/invitations/handler.ts:643-666`: NOT_FOUND maps to 404, and
    success returns 201.
  - This is the only migration that defines `claim_guest_invitation`.
- **B2.** The OQ1 resolution is recorded above. The
  `week-setup-flow.spec.ts` header (lines 16-22) states only the dependency.
- **N1.** `fixtures.ts` `resetDisposablePersona` (lines 292-338) guards in
  this order:
  1. Throws if the persona is a stable fixture user.
  2. Throws if the persona is an admin of `FIXTURE.churchGroupId`.
  3. Otherwise deletes the group the persona owns, or just its `users` row.
- **N2.** `week-setup-flow.spec.ts:95, 167-172`: asserts `joinerName` is
  truthy, uses the `[class*="rosterSlot"]` + `has:` exact-name filter, and
  checks `toHaveCount(1)`.

No duplicate or stray files exist (glob for `* N.{ts,tsx,md,yml,sql}` is empty).

## Changes required

### 1. `documentation/staging-environment.md`: fix the stale guard description (lines 159-164)

**The problem.** The sentence at lines 163-164 reads:

> `resetDisposablePersona` hard-guards against ever touching
> `FIXTURE.churchGroupId`.

That described the pre-N1 behaviour and is now wrong. Since b08a3e1, the helper
**intentionally deletes** a disposable persona's member/guest `users` row
*inside* `FIXTURE.churchGroupId`, for example one left over from a crashed
guest Test B. The previous spec put this file off-limits, so the doc fell out
of sync.

**The fix.** Replace only that final sentence (keep lines 148-162 as they are)
with text that states the actual guards:

- It throws, rather than deleting anything, if a persona email resolves to one
  of the two stable fixture users (`FIXTURE.adminUserId` /
  `FIXTURE.memberUserId`).
- It throws if the persona is an **admin** of `FIXTURE.churchGroupId`, so the
  stable fixture group is never cascade-deleted.
- A disposable persona's member/guest row inside the fixture group *is*
  deleted, so a crashed run doesn't block the next one.

Match the surrounding prose style. Do not touch any other part of this file.

### 2. No test, fixture, CI, or config changes

Do not edit any of these:

- `tests/e2e/**`
- `.github/workflows/ci.yml`
- `playwright.config.ts`
- `package.json`
- any product code (`app/**`, `lib/**`, `schemas/**`, `supabase/**`)

If you find a real defect in them while verifying, **do not fix it**. Write it
up in `changes.md` under a "Found but not fixed" heading so the reviewer can
judge it.

## Edge cases the implementation (and the downstream stages) must respect

- **The doc must match the code exactly.** The wording in change 1 must agree
  with the guard order in `tests/e2e/support/fixtures.ts:311-337`. Re-read that
  function before writing. Don't paraphrase from this spec alone.
- **Do not claim AC 5 is met.** Nothing in this pipeline can run the suite
  against staging: the secrets aren't available locally, and the two
  disposable personas aren't provisioned yet. Without staging secrets, every
  affected test skips, so `bun run test:e2e` proves nothing. Do not run it as
  evidence.
- **Keep the OQ1 resolution record.** Do not edit `.pipeline/spec.md`.

## Patterns to copy

- Doc prose style: the existing paragraph at
  `documentation/staging-environment.md:148-164` and the "optional — ... skip
  when absent" phrasing in its secrets table (lines 179-180).

## Verification before finishing

- `bun run lint`
- `bun run typecheck`
- `bun run test`: Jest. It must stay at 147 suites, all passing; `tests/e2e/`
  is ignored.
- `bunx playwright test --list`: it must still discover 15 tests in 11 files.

## What `changes.md` must state

- The single doc edit, with before/after line numbers.
- That no test, fixture, CI, or product code changed in this run.
- In plain words: none of the issue #82 E2E assertions has run against
  staging. AC 5 is still pending the human provisioning of
  `E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` (Clerk test users + GitHub
  secrets).
- A "Found but not fixed" heading, if anything turned up.

## Out of scope

- Provisioning Clerk personas or GitHub secrets. Those are human actions.
- Adding a third-party-identity `ALREADY_CLAIMED` 409 test.
- Rewording other pre-existing comments, for example `seedSyntheticUser`'s
  "only two real Clerk personas" note in `fixtures.ts`.
- Phase 2+ flows (chat, document library).
