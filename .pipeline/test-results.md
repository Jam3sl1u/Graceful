# Test Results — Issue #43: Withdraw invitation (`DELETE /api/invitations/:id`)

## Verdict: PASS

All checks pass, including new tests written independently by this stage.

Working directory confirmed: `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-43`
(branch `issue-43-implement-withdraw-invitation`, HEAD `af03ca6` — "Implement DELETE
/api/invitations/:id (withdraw invitation, #43)").

## Commands run (independently, not just trusting changes.md)

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run test` (Jest) — **29 suites / 365 tests passed** (0 failed), including:
  - the coder's `tests/unit/app/api/invitations-withdraw-route.test.ts` (8 cases)
  - this stage's new `tests/unit/app/api/invitations-withdraw-route-tester-supplement.test.ts`
    (4 cases, added below)

This matches the coder's claimed 28 suites / 361 tests, plus the one new
suite / four new tests added by this stage (29 / 365 total).

## Coverage review of the coder's own test file

`tests/unit/app/api/invitations-withdraw-route.test.ts` covers, and I
independently confirmed by reading `app/api/invitations/handler.ts`
(`withdrawInvitation`) line-by-line against `.pipeline/spec.md`:

- 403 FORBIDDEN for `member` role (role gate via `requireRole`).
- 401 UNAUTHENTICATED when `getToken` yields no JWT.
- 404 NOT_FOUND when the invitation lookup returns `null`.
- 409 CONFLICT for `status: "accepted"` and `status: "denied"` (two cases;
  Decision 1 — non-pending is a hard reject, not idempotent-200 like
  `denyInvitation`).
- 500 INTERNAL when the invitation lookup query errors.
- Happy path (`pending` -> `withdrawn`): asserts the update payload is
  exactly `{ status: "withdrawn" }` with `responded_at` explicitly
  `undefined` (confirms the spec's "leader action, not a member response"
  distinction from `denyInvitation`); asserts the `notifications` insert
  targets `TARGET_USER_ID` (the invited member, not the actor) with
  `type: "invitation_withdrawn"`; asserts the `write_audit_log` RPC call
  carries `p_action: "invitation.withdrawn"` and the expected metadata.
- 500 INTERNAL when the notification insert errors (confirms the insert
  error is not silently swallowed, per spec).

This is solid coverage. I found four gaps and closed them independently
rather than trusting the coder's summary at face value (see next section).

## New tests added by this stage

`tests/unit/app/api/invitations-withdraw-route-tester-supplement.test.ts`
(untracked, not yet committed — for the Reviewer/human to pick up):

1. **`guest` role -> 403 FORBIDDEN.** The coder's suite only tries `member`
   for the role gate; the spec explicitly names "member/guest" together as
   the excluded roles. Confirms `requireRole` rejects `guest` too, not just
   `member`.
2. **500 INTERNAL when the invitations `UPDATE` query itself errors**
   (distinct from the initial `SELECT` erroring, which is the only error
   path the coder's suite exercises). Closes a real gap — the handler has a
   separate `updateError` branch (line ~348 of `handler.ts`) that had zero
   test coverage.
3. **404 NOT_FOUND when the `UPDATE` matches no row** (e.g. a row that
   passed the initial `pending` check but was concurrently modified/deleted
   before the update). Exercises the handler's second, distinct `!updated`
   404 branch (line ~351), also previously uncovered.
4. **Scoping regression guard:** asserts the invitation lookup's `.eq(...)`
   calls include `["id", INVITATION_ID]` and
   `["church_group_id", CHURCH_GROUP_ID]` but never a `user_id` filter (on
   either the actor's or the target member's id). This is the specific,
   deliberate behavioral difference from `denyInvitation` per the spec ("the
   leader is withdrawing someone else's invitation" — scoped by
   `church_group_id` only, NOT `user_id`). None of the coder's fixtures
   record `.eq(...)` arguments, so a regression here (e.g. copy-pasting
   `denyInvitation`'s `.eq("user_id", ctx.userId)` filter, which would
   silently break withdrawal for every invitation the actor didn't
   themselves create) would have gone undetected by the existing suite
   while still returning green.

All 4 new tests pass against the current implementation.

## Manual verification against the spec

- **`supabase/migrations/20260712000002_invitation_withdrawn_notification_type.sql`**
  — read and compared structurally against the precedent
  `20260711000001_service_week_notification_types.sql`: same header/UP/DOWN
  shape, correct `ALTER TYPE notification_type ADD VALUE IF NOT EXISTS
  'invitation_withdrawn'` body, timestamp prefix `20260712000002` correctly
  sorts after `20260712000001_accept_invitation_rpc.sql`. Cannot be applied
  against a live Postgres instance in this environment (same limitation the
  coder flagged) — structurally correct, not run.
- **`types/domain.ts`** — confirmed `"invitation_withdrawn"` was added to
  `NotificationType` immediately after `"invitation_denied"`, no other
  values touched.
- **`app/api/invitations/handler.ts`** (`withdrawInvitation`) — read in full
  and checked against every numbered step in spec.md section 3: auth ->
  role gate -> JWT check -> scoped lookup (`church_group_id` only) -> 409 on
  non-pending -> update to `{ status: "withdrawn" }` only (no
  `responded_at`) -> notify `inv.user_id` with the exact payload shape
  specified (verified column names against `lib/supabase/types.ts`'s
  `NotificationsRow`) -> audit log with the specified action/metadata ->
  `TODO(#45/#36)` comment present, `cancelReminder` not imported or called
  -> `ok({ invitation: toInvitationResponse(updated) })`. Matches the spec
  exactly.
- **`app/api/invitations/[id]/route.ts`** — confirmed the `DELETE` handler
  matches the wiring pattern in `deny/route.ts` (awaits `params`, calls
  `withdrawInvitation(req, id)`); confirmed the import path is
  `"../handler"` (one level up), which is correct for this file's actual
  location (`app/api/invitations/[id]/route.ts`) — the coder's changes.md
  note about `spec.md`'s literal `"../../handler"` sample being wrong for
  this file (as opposed to the one-level-deeper `deny/route.ts`, where
  `"../../handler"` is correct) checks out; `tsc --noEmit` passing on the
  actual `"../handler"` import confirms it.
- **RLS rationale** — spot-checked against
  `supabase/migrations/20260704000001_rls_policies.sql` per spec's citation;
  did not attempt to run RLS policies live (no DB in this environment), but
  the policy names/shapes cited in spec.md's rationale section are present
  in that migration file.

## Failure case explicitly exercised

Per the pipeline contract's requirement of "at least one failure case":
this stage's new update-query-error test (#2 above) and the update-returns-
no-row test (#3 above), plus the coder's own notification-insert-error and
lookup-query-error tests, together cover every DB-error/failure branch in
the handler (select error, update error, update-no-row, notify error). All
return 500/404 as specified, none silently swallow the error, and no side
effects occur beyond the point of failure.

## Out-of-scope items (correctly not implemented, confirmed by reading the diff)

- No bulk withdrawal endpoint added.
- `cancelReminder` (`lib/upstash/qstash.ts`) is not imported or called;
  only a `TODO(#45/#36)` comment marks the deferred work, consistent with
  the spec (the stub still throws if called, which would have broken the
  handler).
- No `event_attendees` cleanup — confirmed unreachable in practice since the
  handler 409s before the update whenever `status !== "pending"`, and
  `event_attendees` rows only exist for accepted invitations.

## Notes for the Reviewer

- The new supplement test file
  (`tests/unit/app/api/invitations-withdraw-route-tester-supplement.test.ts`)
  is currently **untracked** in this worktree — it was not committed by this
  stage (Testing does not commit; that's outside this stage's role per
  AGENTS.md). It needs to be picked up/committed by a later step for it to
  ship with the PR.
- No code was modified by this Testing stage. No test failures were found;
  nothing was patched around.
