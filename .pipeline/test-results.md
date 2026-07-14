# Test Results — Issue #49: Invitation Response screen (mobile, no-login)

## Verdict: PASS

All checks re-run independently in the pinned worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-49`) using Bun,
per AGENTS.md. No source files were changed by this stage — only two new
test files were added. This file overwrites the stale leftover from a prior
issue (#44) that was still sitting at this path.

## Commands run

- `bun run lint` (`eslint .`) — clean, no errors.
- `bun run typecheck` (`tsc --noEmit`) — clean, no errors.
- `bun run test` (Jest, full suite) — confirmed the pre-existing baseline of
  **31 suites / 380 tests** passing before adding anything (matches the
  Coding stage's claim in `changes.md`), then re-ran with the 2 new test
  files added: **33 suites / 407 tests passed, 0 failures, 0 regressions**.

## New test files written by this stage

- `tests/unit/app/api/invitations-deny-route-token.test.ts` (12 tests) —
  covers the new no-session `responseToken` branch of `denyInvitation`
  (`app/api/invitations/handler.ts`), mirroring the existing no-session
  cases in `invitations-accept-route.test.ts`:
  - Happy path: 200, `getAnonSupabaseClient` used, `getSupabaseClient`/Clerk
    `auth()` never touched, RPC called with the right `p_invitation_id`/
    `p_response_token`/`p_reason` params.
  - Omitted reason is coerced to `null` before being passed to the RPC.
  - Already-responded: `alreadyResponded: true` with the current (non-denied)
    status passed through.
  - Malformed `responseToken` (wrong length, non-hex) → 400
    `VALIDATION_FAILED`, RPC never called.
  - `reason` > 200 chars → 400 `VALIDATION_FAILED` even with an otherwise
    valid token (failure case).
  - RPC error-message mapping: `NOT_FOUND`→404, `FORBIDDEN`→403,
    `EXPIRED`→410, unexpected message→500 `INTERNAL`.
  - Token branch never falls through to the authenticated path (the
    `lookup` callback and Clerk `auth()` are never invoked when a token is
    present).
  - Spot-check that the body-parse-before-`requireAuth` reorder didn't
    change session-path behavior: no-token + no Clerk session still 401s
    before ever calling `getSupabaseClient`/`getAnonSupabaseClient`.
  - Re-ran the 13 pre-existing tests in `invitations-deny-route.test.ts`
    (the authenticated in-app path) unmodified — still pass, confirming the
    reorder is behavior-preserving there.

- `tests/unit/app/invite-response.test.tsx` (15 tests) — covers the
  `InviteResponse` client component
  (`app/(public)/invite/[token]/invite-response.tsx`) with `fetch` mocked
  directly, jsdom opted in via `/** @jest-environment jsdom */` per spec
  Section 6:
  - Loading state before the lookup resolves.
  - Happy path: card renders role note / service week title / event
    name+location from a pending lookup; Accept posts
    `{ responseToken }` to `/accept` and lands on the accepted-success view
    with a `/dashboard` link.
  - Decline flow: tapping Decline does not submit (verified no second
    fetch call fires); reveals a `maxLength=200` textarea + Confirm/Keep
    it; Confirm posts `{ responseToken, reason }` to `/deny` and lands on
    declined-success; "Keep it" cancels back to the two-button state
    without ever submitting.
  - Edge case: empty `events` → "Details coming soon", no crash.
  - Edge case: null `roleNote`/`serviceWeek.title`/event `location` are all
    omitted cleanly (spec Section 7).
  - Edge case: already-responded on load (`status: "accepted"`) → friendly
    unavailable view; raw status string never rendered.
  - Edge case: `status: "expired"` on load → unavailable view.
  - Edge case: re-tap after already responding (`alreadyResponded: true`
    with a non-accepted status on the accept response) → unavailable view.
  - Edge case: 410 on accept submission (expired-at-submit-time) →
    unavailable view; raw `EXPIRED`/`410` never rendered.
  - Edge case: double-tap guard — both buttons disable while an accept is
    in flight; a second click on the now-disabled button does not issue a
    second request (fetch call count stays at 2: initial lookup + one
    accept).
  - Failure case: network error (`fetch` rejects) on the initial lookup →
    friendly unavailable view, not a crash or unhandled rejection.
  - Failure case: 404 on the initial lookup → unavailable view; raw
    `NOT_FOUND` code never rendered.
  - Failure case: non-terminal error (500) on accept submission → inline
    `role="alert"` message that does not leak `INTERNAL`/`500`, and the
    screen stays on the `ready` view (card + both buttons still present).

## Manual / non-automated verification

- `middleware.ts` (`isPublicRoute`) was read directly and confirmed to list
  both `"/api/invitations/respond/(.*)"` and `"/api/invitations/(.*)/deny"`
  alongside the pre-existing `"/api/invitations/(.*)/accept"`, matching
  spec Sections 4 and 5. This repo has no existing middleware unit-test
  precedent (`find tests -iname '*middleware*'` returns nothing), so this
  remains a static/config-level check, not an automated test.
- `supabase/migrations/20260713000001_deny_invitation_rpc.sql` was read in
  full and compared against `20260712000001_accept_invitation_rpc.sql`'s
  established pattern (SECURITY DEFINER, `SET search_path = ''`,
  token-or-JWT authorization, graceful already-responded short-circuit
  before the expiry check, BR-08 `denial_count` computed the same way as
  the handler's authenticated path, notify block, direct `audit_logs`
  insert since `write_audit_log` needs a JWT, `GRANT EXECUTE ... TO anon,
  authenticated`). Structurally sound and consistent with the accept RPC.
  No live-SQL test harness exists in this repo for any RPC (same situation
  the Coding stage flagged for `accept_invitation`/`get_invitation_by_token`
  before it), so this remains a manual code-review-level check.
- `jest.config.js` / `tests/mocks/css-module.js` changes (new `.tsx`
  `testMatch` entry, CSS-module mock, automatic-JSX-runtime transform) were
  exercised directly by `invite-response.test.tsx` (which would not run at
  all without them) and confirmed not to affect the pre-existing 380
  node-environment tests — full suite green with both old and new tests
  together.

## Gaps / things the Reviewer may want to weigh

- No test exercises the real Supabase RPC SQL end-to-end — an existing,
  repo-wide gap (no live-DB test harness), not specific to this change.
- No middleware-level integration test exists (asserting an actual request
  is let through/blocked by `clerkMiddleware`/`isPublicRoute`) — only
  static confirmation that the route strings were added. This matches the
  repo's pre-existing lack of middleware test coverage, not a new gap
  introduced by this issue.

## Failure cases

None. No test failures encountered in this run — the pre-existing suite
plus the 27 new tests (12 + 15) all pass. Lint and typecheck are both
clean.
