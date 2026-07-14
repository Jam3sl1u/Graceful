# Review — Issue #49: Invitation Response screen (mobile, no-login)

## VERDICT: SHIP

Independently verified in the pinned worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-49`):
`bun run lint` clean, `bun run typecheck` clean, `bun run test` = 33 suites /
407 tests passing (0 failures). Read the full diff (`git diff main...HEAD`),
not just the summaries.

## What I checked and found correct

- **Component (`invite-response.tsx`)** matches spec Sections 3.1-3.4: view
  state machine (loading/ready/unavailable/accepted-success/declined-success),
  no-session lookup on mount, reveal-then-confirm decline with a "Keep it"
  back-out, in-flight button disabling, `maxLength={200}` textarea, and #51
  behavior — expired/used/unknown/500 never surface a raw `error`/`code`/HTTP
  status. Reuses `InvitationStatus`/`EventType` from `@/types/domain` as asked.
- **No-session deny backend (spec Section 5, per the human's Option A
  resolution)** — the new `deny_invitation` RPC is a faithful, line-for-line
  mirror of `accept_invitation_rpc.sql`: SECURITY DEFINER, `SET search_path =
  ''`, token-or-JWT authorization, graceful already-responded short-circuit
  before the expiry check, BR-08 `denial_count`, notify block, direct
  `audit_logs` insert, `GRANT ... TO anon, authenticated`. Handler token
  branch maps errors exactly like accept (NOT_FOUND/FORBIDDEN/EXPIRED/500).
- **Handler reorder** (body-parse before `requireAuth`) is behavior-preserving
  for the authenticated path — confirmed by the 13 pre-existing deny tests
  still green plus an explicit reorder spot-check. Auth for the no-token path
  is still enforced (401), and the token path is authenticated inside the RPC.
- **Middleware** — both new public routes are additive; the authenticated deny
  path still self-enforces via `requireAuth`, same pattern as `.../accept`.
- **Green Accept button** — `.acceptButton` overrides background via the
  `className` the `Button` component appends after its variant class; the
  shared `--color-accent` token is untouched. Buttons are full-width, 56px
  min-height (>= 44px A-08).
- **Tests are meaningful, not superficial** — the component test covers happy
  path, all named Section 7 edge cases (empty events, null fields,
  already-responded on load vs. re-tap, expired-on-load vs. 410-on-submit,
  double-tap guard, non-terminal 500 stays on ready), and asserts raw codes
  are never rendered. The deny-route-token test covers happy path, null-reason
  coercion, validation (bad token, >200 reason), full error mapping, and that
  the token branch never falls through to Clerk.

## Non-blocking notes (for the orchestrator / human, not fixes)

- The two tester files (`tests/unit/app/invite-response.test.tsx`,
  `tests/unit/app/api/invitations-deny-route-token.test.ts`) are still
  UNTRACKED at review time — they are not in commit c9c5bee (which is the
  Coding stage's commit). This is expected at this pipeline point, but the
  orchestrator MUST commit them (and the updated `test-results.md`) as part of
  shipping; otherwise the branch ships source without its tests. Worth an
  explicit check given this repo's history of silent handoff loss.
- No live-SQL/RPC test harness and no middleware integration test exist —
  pre-existing repo-wide gaps, not introduced here. The RPC and middleware
  changes were verified by static review against the established accept
  pattern only.
- Minor: in `handleAccept`/`handleDeclineConfirm`, a 200 response with
  `alreadyResponded: false` and an unexpected non-terminal status is a silent
  no-op (stays on `ready`, no error). Not reachable given the RPC contract;
  noting for completeness, not a fix.
