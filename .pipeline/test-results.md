# Test Results — Issue #82: Full E2E regression pass across all Phase 1 critical paths

## Summary: PASS

This is a test/CI/doc-only change (D3 — no product code modified), so
"testing the tests" means: (1) re-running every automated check the coder
claims to have run, and (2) independently cross-checking the new specs'
assertions (UI copy, API response shapes, DB/RPC behavior) against the
actual application code, since the specs themselves cannot execute without
staging secrets that don't exist in this environment.

## Commands re-run independently

| Command | Result |
| --- | --- |
| `bun run lint` | PASS — `eslint .`, no output, exit 0 |
| `bun run typecheck` | PASS — `tsc --noEmit`, no output, exit 0 |
| `bun run test` | PASS — 147 suites / 3144 tests, 0 failures, 5.6s (confirms `tests/e2e/` is ignored by Jest as claimed) |
| `bunx playwright test --list` | PASS — 15 tests across 11 files discovered, including all 3 new specs (`week-setup-flow.spec.ts`, `notification-inbox.spec.ts`, `guest-invitation.spec.ts` x2 tests) |

Per spec's explicit instruction, `bun run test:e2e` was **not** run locally
(no staging secrets in this environment — every new spec would just skip,
proving nothing).

## Independent verification against source (not just trusting changes.md)

Cross-checked every UI selector, API shape, and DB/RPC claim the new specs
make against the actual implementation, rather than trusting the coder's
summary:

- **`PUT /api/church-group`** (`app/api/church-group/route.ts`): confirmed
  `ok(data, 201)` where `data` is the raw `create_church_group` RPC result,
  and the RPC (`supabase/migrations/20260706000001_church_group_create_rpc.sql`)
  `RETURNS public.church_groups` — so `createGroupBody.data.id` in
  `week-setup-flow.spec.ts` is correct, not a guess.
- **BR-10 event timing** (`schemas/events.ts` `validateEventTiming`):
  confirmed the 72h-anchor-at-00:00:00Z window and `end > start` rule; the
  spec's rehearsal (anchor -24h/-22h) and service (anchor/+2h) times both
  satisfy it.
- **`claim_guest_invitation` ALREADY_CLAIMED → 409**: confirmed in
  `app/api/invitations/handler.ts:646-647` (`fail(..., CONFLICT, 409)`) and
  the `pending_guest_` clerk_id prefix in
  `supabase/migrations/20260805000001_guest_invitation_flow.sql`. The test's
  409 assertion (not a 201 `already_claimed: true`) is correct per the real
  RPC/handler behavior, matching the spec's instruction to "assert whichever
  it actually does."
- **Roster-slot scoping** (the item changes.md flagged as unverified against
  a live render): read `week-view.tsx`'s actual roster markup — each member
  renders inside one `div.rosterSlot` containing an avatar span, a
  `span.memberName` (exact member name), a status badge, and conditionally a
  "+ Invite" button. `adminPage.getByText(joinerName, { exact: true
  }).locator("..")` resolves to that `div.rosterSlot`, which does correctly
  scope the click/assertion away from the admin's own "+ Invite" button.
  This holds up against the real DOM structure.
- **UI copy/selectors**: verified against source for all of: "You're in!"
  (`join-form.tsx`), "Finish setting up your account" / "You're all set!"
  (`guest-claim-form.tsx`), "Guest email" label / "Invite guest" button /
  "needs this link to create their account" text (`week-view.tsx`),
  "View your invitation" link (`guest-claim-form.tsx`), "You're on the
  schedule" heading (`invite-response.tsx`), "1 song" text
  (`setlist-builder.tsx`), "Invitation withdrawn" title / `invitation_withdrawn`
  type (`app/api/invitations/handler.ts`). All match exactly.
- **Gating logic** (`tests/e2e/support/env.ts`): `e2eDisposablePersonasEnabled`
  correctly requires both the base `REQUIRED_VARS` and the two new
  `DISPOSABLE_PERSONA_VARS`; `notification-inbox.spec.ts` and guest-invitation
  Test A gate on `e2eAuthEnabled` only (run without the OQ1 secrets), as the
  spec requires.
- **`resetDisposablePersona` / `teardownFixtures` churchGroupIds guard**
  (`tests/e2e/support/fixtures.ts`): confirmed both throw before ever
  touching `FIXTURE.churchGroupId`, matching the spec's hard-guard
  requirement.
- **`.github/workflows/ci.yml`**: confirmed the two new secrets were added
  only to the `e2e` job's `env:` block, and the `check-secrets` job/gate
  (`has-e2e-secrets`) was left untouched, as the spec required.
- **`documentation/staging-environment.md`**: confirmed the new secrets are
  documented as optional, §7.2 was added, and the stale "501 stub" note was
  corrected.

## Coverage against the pipeline contract

- **Happy path**: week-setup-flow's full create-group → join → build-setlist
  → schedule-events → invite → Pending roster/DB flow; guest-invitation
  Test A's existing-user invite → accept flow; notification-inbox's
  withdraw → list → mark-read flow.
- **Spec-named edge cases**: BR-10 timing window, idempotent
  mark-notification-read, guest existing-user role-preservation, disposable
  persona reset-before-and-after, `seedSong` cross-group `createdBy`, the
  admin's own roster "+ Invite" collision (roster-slot scoping).
- **Failure cases** (required, present in both specs that need one):
  `notification-inbox.spec.ts` asserts `PATCH /api/notifications/:id/read`
  on another user's notification returns exactly 404 (not 403/200);
  `guest-invitation.spec.ts` Test B asserts re-`POST
  /api/invitations/guest/claim` with an already-claimed token returns 409.

## Findings / caveats (informational, not blocking)

- As changes.md itself discloses, none of the three new specs can actually
  *execute* in this environment (no `E2E_ADMIN_EMAIL`/`E2E_SETUP_ADMIN_EMAIL`/
  etc. secrets here) — they only proved out via static discovery
  (`playwright test --list`) plus this stage's manual source cross-check.
  Genuine runtime confirmation is only possible once a human provisions the
  two disposable Clerk personas and the corresponding GitHub secrets (OQ1,
  Option A, already resolved by the human per changes.md). This is a known,
  disclosed limitation of the issue's scope, not a defect in this change.
- No product code was touched, consistent with D3.

## Verdict for Review

All re-run checks pass; all spot-checked claims against source code hold up.
No failing tests, no discrepancies found between changes.md's claims and the
actual diff. Recommend proceeding to Review.
