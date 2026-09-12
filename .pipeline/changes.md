# Changes — Issue #82: Full E2E regression pass across all Phase 1 critical paths

## Human resolution applied to OQ1

The planner's spec.md flagged an OPEN QUESTION (OQ1) about provisioning two
extra disposable staging Clerk personas. A human resolved it as **Option A**:
provision `E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` as two disposable Clerk
test-mode users and add them as GitHub Actions secrets. This implementation
proceeds on that basis — the two new specs self-skip via
`e2eDisposablePersonasEnabled` when those secrets are absent (same
skip-not-fail pattern as the rest of the suite), so the repo stays green
locally and in a secretless CI, and becomes fully exercised once a human
actually provisions the two Clerk users and secrets (an action outside this
coding stage's scope).

## Files created

- `tests/e2e/week-setup-flow.spec.ts` — one continuous test: disposable
  setup-admin creates a church group (`PUT /api/church-group`), disposable
  guest joins it via invite code through the `/join/:code` UI, admin creates
  a service week (`POST /api/service-weeks`), builds a setlist through the
  builder UI, creates a rehearsal + service event (`POST /api/events`,
  BR-10-compliant timing), sends a roster invite through the Week View UI,
  and asserts the roster shows "Pending" (UI) + a pending `invitations` row
  (DB). Gated on `e2eDisposablePersonasEnabled`. Resets both disposable
  personas before and in `finally`, tears down the throwaway church group
  (cascades) and the seeded song.
  - Note: the admin's own roster slot also renders a "+ Invite" button (no
    invitation exists for their own week either), so the test scopes the
    click/assertion to the joiner's roster slot by locating the DOM node
    containing their name, not a bare `getByRole` query — otherwise
    Playwright's strict-mode would fail on two matching buttons.
- `tests/e2e/notification-inbox.spec.ts` — seeds a pending invitation,
  withdraws it as admin (`DELETE /api/invitations/:id`, which fires an
  `invitation_withdrawn` notification), then as the member asserts
  `GET /api/notifications`, `GET /api/notifications/unread-count`,
  `PATCH /api/notifications/:id/read` (including idempotent re-PATCH), and
  the required failure case — PATCHing another user's (admin's) notification
  from the member session returns 404, never 403/200. All assertions go
  through `page.request` on the authenticated session (D1), not the
  service-role client. Gated on `e2eAuthEnabled` only (uses the stable
  fixture).
- `tests/e2e/guest-invitation.spec.ts` — two tests:
  - Test A (existing-user path, `e2eAuthEnabled` only): admin invites
    `E2E_MEMBER_EMAIL` as a guest via `POST /api/invitations/guest`, asserts
    `isNewUser: false`, `guestUserId` unchanged, `accountSetupUrl: null`,
    the member's role is untouched, then accepts via `/invite/:token` UI.
  - Test B (new-user path, `e2eDisposablePersonasEnabled`): admin invites
    `E2E_GUEST_EMAIL` through the Week View "Invite a guest" UI, asserts the
    account-setup-link paragraph, reads the placeholder user
    (`pending_guest_` clerk_id prefix, `role: "guest"`) from the DB, guest
    claims via `/guest/:token` UI, asserts the placeholder's `clerk_id` is
    now the guest's real Clerk id and `church_group_id` matches the fixture
    group, guest accepts via `/invite/:token`, then re-POSTs
    `/api/invitations/guest/claim` with the same token and asserts 409
    (`claim_guest_invitation`'s `ALREADY_CLAIMED` branch, confirmed by
    reading `app/api/invitations/handler.ts`'s `claimGuestInvitation` — it
    maps `ALREADY_CLAIMED` to a 409 CONFLICT, not a 201 idempotent response).

## Files modified

- `tests/e2e/support/env.ts` — added `DISPOSABLE_PERSONA_VARS` and
  `e2eDisposablePersonasEnabled`; extended the header doc block.
- `tests/e2e/support/auth.ts` — added `signInAsEmail(page, emailAddress)`,
  delegating to the same `clerk.signIn` call as `signInAs`.
- `tests/e2e/support/fixtures.ts`:
  - `seedSong` now takes an optional `createdBy` (defaults to
    `FIXTURE.adminUserId`, existing callers unaffected) — needed because the
    week-setup-flow spec seeds a song in a brand-new church group, where
    `FIXTURE.adminUserId` isn't a valid `created_by` FK target.
  - Added `resetDisposablePersona(svc, email)`: resolves the persona's Clerk
    id, looks up its `users` row, hard-throws if it resolved to
    `FIXTURE.churchGroupId` (never touch the stable fixture), then deletes
    the church group it owns (if admin — cascades) or just its `users` row
    (if member/guest).
  - `TeardownIds` gained `churchGroupIds?: string[]`, deleted last in
    `teardownFixtures` (cascades everything under it), with the same
    stable-fixture guard.
- `.github/workflows/ci.yml` — added `E2E_SETUP_ADMIN_EMAIL` /
  `E2E_GUEST_EMAIL` to the `e2e` job's `env:` block (sourced from the
  corresponding secrets) and updated the job's leading comment to mention
  the #82 regression specs and that the two new persona secrets are
  optional. Did not touch the `check-secrets` gate.
- `documentation/staging-environment.md` §7 — added the two new secrets to
  the table (marked optional), extended item 1 to describe the disposable
  personas and the reset-on-both-ends contract, added a new "§7.2 Phase 1
  regression pass (issue #82)" subsection, and corrected the stale
  "`GET /api/notifications` is a 501 stub" note (obsolete since #71 shipped
  the real inbox API — `notification-inbox.spec.ts` now asserts through it
  directly).

## What the Tester should focus on

- All three new specs are correctly gated: `week-setup-flow.spec.ts` and the
  guest-invitation new-user test skip without
  `E2E_SETUP_ADMIN_EMAIL`/`E2E_GUEST_EMAIL`; `notification-inbox.spec.ts` and
  the guest-invitation existing-user test skip without the base `e2eAuthEnabled`
  secrets. None of them can run against real staging in this environment
  (no secrets configured here) — verification was limited to `bun run lint`,
  `bun run typecheck`, `bun run test` (Jest unaffected, `tests/e2e/` is
  ignored), and `bunx playwright test --list` (all 15 specs across 11 files
  parse and are discovered, including the 3 new ones).
- The week-setup-flow roster-slot scoping (admin's own "+ Invite" button vs.
  the joiner's) is worth double-checking against the real DOM once staging
  secrets exist — it's inferred from `week-view.tsx`'s `rosterSlot` markup,
  not verified against a live render.
- The guest-invitation Test B's assertion that re-claiming returns 409 (not
  a 201 `already_claimed: true`) is based on reading
  `claimGuestInvitation`'s error-mapping in `app/api/invitations/handler.ts`
  (`ALREADY_CLAIMED` → `fail(..., ErrorCode.CONFLICT, 409)`), not on running
  the RPC — confirm this against a real `claim_guest_invitation` call if
  possible.
- No product code was changed (D3) — everything here is test/CI/doc only.
