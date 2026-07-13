# Review: Issue #42 — Deny invitation with reason (POST /api/invitations/:id/deny, BR-08 denial cap)

## VERDICT: SHIP

## Basis
Read spec.md, changes.md, test-results.md; read the actual source
(`app/api/invitations/handler.ts`, `schemas/invitations.ts`,
`app/api/invitations/[id]/deny/route.ts`, the new test file); re-ran
`bun run lint` (clean), `bun run typecheck` (clean), `bun run test`
(26 suites / 339 tests pass). Did not trust the summaries.

## Spec conformance — verified line by line
- `denyInvitationSchema`: `reason` optional, `.trim().max(200)`, no `.min(1)` —
  empty/whitespace-only accepted, coerced to null in handler. Matches.
- `denyInvitation`: no `requireRole` (per OPEN QUESTION 1); ownership scoping via
  `id` + `church_group_id` + `user_id` → cross-user/cross-group/missing all 404,
  never leaking existence. Tolerant body parse (`body ?? {}`). Idempotency
  short-circuit on `status !== "pending"` returns 200 with no update/count/audit.
  `denial_count` derived from prior denied rows + 1 (not the row's default 0).
  Audit `invitation.denied` logs only `reason_provided: boolean`, never the raw
  reason text (PII handled correctly). `TODO(#67/#68)` for deferred dispatch.
- BR-08 send guard in `createInvitation`: placed after the `!week` 404 and before
  the BR-05 check; counts `status='denied'` rows for `(userId, serviceWeekId)`;
  `>= 3` → 409 CONFLICT. Purely additive; no existing branch reordered.
- Route file wired to `denyInvitation` with the `params: Promise<{id}>` pattern;
  stub removed.

## Test quality — meaningful, not superficial
Tests inspect the real `.update()` payload the handler builds (via `onUpdate`
hook) and the exact `write_audit_log` RPC shape, not stubbed return values. The
idempotency test wires only select/update on `from()` so it would fail loudly if
the handler tried the priorDenied query or update — it doesn't. Covers 401 (both
no-JWT and null-Clerk-user), 404, 400 (too long + non-string), happy path
(count=1), empty/whitespace body → null, idempotent already-denied (no
update/rpc), count=2 with a prior denied row, 500 on lookup error, and the BR-08
send guard both firing at 3 and not over-triggering at 2.

## Critical checks
- Regression risk on existing `invitations-route.test.ts` from the new
  `deniedForWeek` select in `createInvitation`: the shared fixture returns
  `{data: [], error: null}` (length 0 < 3), so the guard passes through and the
  pre-existing BR-05 logic is unchanged. All 12 pre-existing tests still pass.
- `deniedForWeek` query intentionally omits `church_group_id` — matches the
  spec's exact query and is safe because `service_week_id` is group-unique.
- Reason text is never written to the audit log. Confirmed.

## Non-blocking notes (not defects, no action required to ship)
- denial_count is computed read-then-write (two queries), so it's theoretically
  racy under concurrent denials of the same member+week. In practice a member
  denies their own single pending invitation, so this is not exploitable; out of
  scope for this issue.
- No deadline/expiry check on a still-`pending` row past its response_deadline;
  spec does not require it (expiry is handled by status transitions elsewhere).
- `.claude/workflows/handle-issues.js` shows as locally modified in this worktree
  but is not part of commit 0e7d263 and is unrelated to issue #42 — correctly
  left out of the diff.

Green tests here reflect correct behavior. Ship it.
