# Review — Issue #82 (re-run after remediation b08a3e1 + doc fix e7d2a38)

VERDICT: NEEDS WORK

## Scope reviewed
- All four `.pipeline/` artifacts. `spec.md` and `test-results.md` are uncommitted working-tree edits from this run. That is expected.
- The full branch diff `git diff main...HEAD` covers ci.yml, staging-environment.md, the three new specs, and support/{auth,env,fixtures}.ts. I reviewed all of it, not only this run's one doc edit.
- I re-ran these myself: `bun run typecheck` and `bun run lint` are clean, and `bunx playwright test --list` finds 15 tests in 11 files. The testing stage reports Jest at 147 suites. I did not re-run Jest.

## This run's change (doc edit, e7d2a38): correct
The new text in `documentation/staging-environment.md` §7.1 item 1 matches `resetDisposablePersona` in `tests/e2e/support/fixtures.ts`:
- It throws on `FIXTURE.adminUserId` / `FIXTURE.memberUserId`.
- It throws on an admin of `FIXTURE.churchGroupId`.
- Otherwise it deletes the owned group, or just the member/guest `users` row.

The edit stays in scope, and the OQ1 record is preserved. The previous BLOCK findings B1, B2, N1 and N2 are confirmed fixed in the code.

## Must fix

### 1. `tests/e2e/guest-invitation.spec.ts` leaks `invitation_accepted` notifications into the stable admin's inbox on every run
Both tests accept the invitation through `/invite/:token`. Test A does it at line ~203. Test B does it at line ~289 via "View your invitation" -> Accept.

That accept path, `supabase/migrations/20260805000001_guest_invitation_flow.sql:289-307`, inserts an `invitation_accepted` notification for `v_inv.invited_by`, which is `FIXTURE.adminUserId` in both tests. The notification has `link_entity_id = invitationId`.

`notifications.link_entity_id` has no FK. The `user_id` / `church_group_id` cascades never fire, because both rows belong to the stable fixture. Deleting the invitation or the service week does not remove the notification. So each staging run permanently adds 2 unread rows to the stable admin's inbox.

The existing pattern already handles this. `tests/e2e/invitation-accept.spec.ts:69-73` passes `notificationLinkEntityIds: [invitationId]` for this exact reason. `notification-inbox.spec.ts` in this same diff does it too.

Fix: in both `finally` blocks of `guest-invitation.spec.ts`, add `notificationLinkEntityIds: invitationId ? [invitationId] : []` to the `teardownFixtures` call:
- Test A, line ~213
- Test B, line ~329

This is a test-only change of about two lines. Re-run lint, typecheck and `playwright test --list` afterwards.

## Non-blocking notes (no action required)
- `notification-inbox.spec.ts` uses `futureDateString(11)` in the fixture group, the same offset as `calendar-sync.spec.ts`. The suite runs with `workers: 1` and every spec tears down in `finally`. The repo already reuses offsets (accept and deny both use 3), so this is consistent with existing practice.
- `[class*="rosterSlot"]` matches only the two `styles.rosterSlot` divs in `week-view.tsx` (lines 522 and 560). No other class contains that substring, so the `toHaveCount(1)` guard is sound.

## AC 5: still unverified (human action)
No issue #82 E2E assertion has run against staging. The new-user and week-setup tests skip until a human:
- provisions the `E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` Clerk test users, and
- adds them as GitHub Actions secrets.

The remaining tests still need a real staging run. Do not treat this branch as having met "all tests pass against staging in a single CI run" until a green CI `e2e` job with those secrets present has been observed.
