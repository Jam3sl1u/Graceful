# Spec — Issue #82: [Sprint 4] Full E2E regression pass across all Phase 1 critical paths (remediation of review BLOCK on ef31bd1)

## RESOLVED OPEN QUESTION — OQ1 (operator decision, 2026-11-16)

The human operator answered OQ1 in chat on 2026-11-16 via an interactive
question, selecting **Option A (Recommended)**: disposable test users. The
operator will create two throwaway staging sign-in accounts and add
`E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` as GitHub Actions secrets; until
then the two tests that need them skip themselves. Option B (simulating
create-group/join/guest-claim with service-role writes) was not chosen.

## Current state (verified in this worktree)

Commit ef31bd1 already added the following. **Do not recreate them; edit only
what is listed under "Changes required".**

- `tests/e2e/week-setup-flow.spec.ts`: the one continuous admin week-setup test.
- `tests/e2e/notification-inbox.spec.ts`: the review passed it. **Do not touch.**
- `tests/e2e/guest-invitation.spec.ts`: Test A (existing user) and Test B (new user).
- `tests/e2e/support/env.ts` (`e2eDisposablePersonasEnabled`) and
  `tests/e2e/support/auth.ts` (`signInAsEmail`). **Do not touch.**
- `tests/e2e/support/fixtures.ts`: `seedSong({ createdBy })`,
  `TeardownIds.churchGroupIds`, and `resetDisposablePersona`.
- `.github/workflows/ci.yml` and `documentation/staging-environment.md` §7 /
  §7.2: the review passed them. **Do not touch.**
- AC #1 (run #52's and #66's suites together against one staging deploy) is
  already met. `playwright.config.ts` uses `testDir: ./tests/e2e`,
  `workers: 1`, and the CI job makes a single `bun run test:e2e` call. Do not
  change the runner.

The review stage's lint, typecheck, Jest (147 suites) and
`playwright test --list` (15 tests / 11 files) runs were all green. The defects
below are in what the assertions check, not in whether the code compiles.

## Changes required

### 1. B1: `tests/e2e/guest-invitation.spec.ts`, Test B re-claim assertion (lines ~161-167)

**Verified against `supabase/migrations/20260805000001_guest_invitation_flow.sql`:**

- Step 9 (line 170) sets `clerk_id = v_clerk_id`.
- On a second call from the **same** Clerk session, step 4 (lines 131-139)
  returns `already_claimed: true` before the code ever reaches the step-6
  `ALREADY_CLAIMED` raise.
- `claimGuestInvitation` (`app/api/invitations/handler.ts:658-666`) then
  returns **201** with `data.alreadyClaimed`, `data.invitationId`,
  `data.guest.userId`, and `data.guest.churchGroupId`.

The current `toBe(409)` is wrong. Replace that block with the following.

a. **Idempotent re-claim (edge case).** POST `/api/invitations/guest/claim`
   with `{ responseToken }` from `guestPage.request`, then assert:
   - `status() === 201`
   - `data.alreadyClaimed === true`
   - `data.invitationId === invitationId`
   - `data.guest.userId === guestUserId`

   Rewrite the comment above it to cite migration **step 4** (the
   idempotent-reclaim path), not the handler's `ALREADY_CLAIMED` mapping.

b. **Required failure case (non-2xx).** POST `/api/invitations/guest/claim`
   from the same `guestPage.request`, with a token that is **well-formed but
   doesn't exist**. Use `generateResponseToken()` imported from
   `./support/fixtures`. It produces 64 lowercase hex characters, which passes
   `claimGuestInvitationSchema` in `schemas/invitations.ts:79-84`, so the
   request reaches migration step 2 and raises `NOT_FOUND`.
   - Assert `status() === 404` exactly.
   - Do **not** send a malformed token. That returns 400 from validation and
     never reaches the RPC.

Keep (b) after (a), inside the same `try`. No teardown changes are needed.
Nothing new is persisted.

### 2. N1: `tests/e2e/support/fixtures.ts`, `resetDisposablePersona` guard

**Problem:** the current guard throws whenever
`row.church_group_id === FIXTURE.churchGroupId`. But Test B deliberately puts
`E2E_GUEST_EMAIL` into the fixture group. If Test B crashes before its
teardown, the next run hits this guard in its defensive reset:

- `guest-invitation.spec.ts:89`
- `week-setup-flow.spec.ts:38`

The guard throws instead of cleaning up, so both specs fail permanently.

**Fix:** keep the signature
`resetDisposablePersona(svc: SupabaseClient, email: string): Promise<void>`.
Replace the guard logic with this exact order:

1. No `users` row for the persona's Clerk id: return. This is unchanged.
2. `row.id === FIXTURE.adminUserId || row.id === FIXTURE.memberUserId`:
   throw. The message must say the persona email resolved to a stable
   fixture user and that the test used the wrong persona email.
3. `row.role === "admin"`:
   - If `row.church_group_id === FIXTURE.churchGroupId`, throw. Never
     cascade-delete the fixture group.
   - Otherwise delete the `church_groups` row. This is unchanged.
4. Otherwise (member / guest / set_leader, in **any** group including the
   fixture group): delete just that `users` row. This is unchanged.
   - Verified safe: `invitations.user_id` and `notifications.user_id` are
     `on delete cascade` (`20260702000003_cluster_3_scheduling_core.sql:80,95`).
   - `created_by` / `invited_by` FKs are `on delete set null`.

Update the function's leading comment so it describes the new guard axis. The
protected things are the two stable fixture user rows and the fixture group,
not "any row in the fixture group". Existing error-wrapping style stays as is.

### 3. N2: `tests/e2e/week-setup-flow.spec.ts`, roster-slot scoping (line ~165)

Make two changes.

1. **Assert the name is non-empty.** Right after reading `joinerRow`, add
   `expect(joinerName).toBeTruthy()`.
2. **Locate the roster slot by structure.** Replace
   `adminPage.getByText(joinerName, { exact: true }).locator("..")` with:

   ```ts
   const joinerRosterSlot = adminPage
     .locator('[class*="rosterSlot"]')
     .filter({ has: adminPage.getByText(joinerName, { exact: true }) });
   await expect(joinerRosterSlot).toHaveCount(1);
   ```

   - `week-view.tsx:522` renders `className={styles.rosterSlot}` from
     `week-view.module.css`. CSS modules keep `rosterSlot` as a substring of
     the generated class name, so the selector matches.
   - Use `has:` with an exact-name child, **not** `hasText:`. `hasText` is a
     case-insensitive substring match, so it could also match the admin's own
     slot if one name contains the other.
   - The `toHaveCount(1)` assertion makes a name collision fail loudly instead
     of silently clicking the wrong slot.

   The `+ Invite` click and the `Pending` assertion still scope to
   `joinerRosterSlot` as they do now.

### 4. B2 follow-through: `tests/e2e/week-setup-flow.spec.ts` header comment (lines 16-21)

The comment currently says OQ1 was "resolved by provisioning
E2E_SETUP_ADMIN_EMAIL / E2E_GUEST_EMAIL". That records a decision nobody made
in the repo.

Reword it to state only the dependency: the test requires the two disposable
staging Clerk personas `E2E_SETUP_ADMIN_EMAIL` and `E2E_GUEST_EMAIL` (see
`documentation/staging-environment.md` §7), and it skips when they are absent.
Do not mention OQ1's resolution status.

## Edge cases the implementation must handle

- **A crashed prior run must not poison the next run.** The disposable guest
  persona left as a `guest` or `member` row inside `FIXTURE.churchGroupId`
  must be cleaned up by `resetDisposablePersona`, not cause it to throw (N1).
- **Never delete `FIXTURE.churchGroupId`, `FIXTURE.adminUserId`, or
  `FIXTURE.memberUserId`.** Use a thrown error, not a silent skip. This
  applies in both `resetDisposablePersona` and `teardownFixtures`
  (`teardownFixtures` is unchanged).
- **Re-claim from the same session is idempotent 201, not 409** (B1). A 409
  `ALREADY_CLAIMED` is reachable only from a *different* Clerk identity. This
  spec doesn't ask for that case; don't add it.
- **The failure-case token must be schema-valid** (64 lowercase hex
  characters) so the request reaches the RPC's `NOT_FOUND` path and returns
  404, not a validation 400.
- **Roster-slot locator:** must match exactly one slot. Fail loudly on zero or
  more than one.

## Patterns to copy

- Failure-tolerant cleanup and multiple browser contexts:
  `tests/e2e/setlist-publish.spec.ts`. This is already how both edited specs
  are structured, so keep it.
- Exact-status failure assertions (`toBe(404)`, not `.ok()`):
  `tests/e2e/notification-inbox.spec.ts` (cross-user PATCH case).
- Error wrapping in fixture helpers: the existing `resetDisposablePersona` /
  `seedSong` style in `tests/e2e/support/fixtures.ts`.

## Verification before finishing

- `bun run lint`
- `bun run typecheck`
- `bun run test`: Jest must be unaffected, because `tests/e2e/` is ignored.
- `bunx playwright test --list`: must still discover 15 tests in 11 files.

Do not run `bun run test:e2e` locally without staging secrets. Every affected
test would skip, which proves nothing.

In `changes.md`:

- State plainly that none of these assertions has been executed against
  staging.
- Cite the migration line numbers you relied on for B1. Don't cite only
  handler lines.

## Out of scope

- Any product code. This issue is a test gate only.
- `notification-inbox.spec.ts`, guest Test A, `env.ts`, `auth.ts`, `ci.yml`,
  `documentation/staging-environment.md`, and `playwright.config.ts`.
- Adding a third-party-identity `ALREADY_CLAIMED` 409 test.
- Provisioning the Clerk personas or the GitHub secrets. Those are human
  actions under OQ1.
- Phase 2+ flows (chat, document library).
