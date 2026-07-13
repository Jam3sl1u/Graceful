# Review — Issue #43: Withdraw invitation (`DELETE /api/invitations/:id`)

VERDICT: SHIP

## Basis for verdict

Reviewed the actual implementation commit `af03ca6` (not just the summaries),
re-ran `bun run lint`, `bun run typecheck`, and `bun run test` independently in
this worktree, and read the handler, route, migration, types, and test file
line-by-line against the spec.

- Lint: clean. Typecheck: clean. Tests: 29 suites / 365 passed.
- `withdrawInvitation` matches spec section 3 step-for-step: auth → role gate
  (`admin`/`set_leader`) → JWT/401 → lookup scoped by `church_group_id` ONLY
  (not `user_id`, correct — leader withdraws someone else's invite) → 404 on
  miss → 409 on non-pending (no side effects) → update to `{ status:
  "withdrawn" }` with NO `responded_at` → member notification to
  `inv.user_id` with `type: "invitation_withdrawn"` (not swallowed on error) →
  audit `invitation.withdrawn` → `TODO(#45/#36)` comment, `cancelReminder` not
  imported/called → `ok({ invitation })`. try/catch mirrors the sibling
  handlers.
- Verified independently that the types support the change: `InvitationStatus`
  includes `"withdrawn"`, `NotificationType` now includes
  `"invitation_withdrawn"`, and every notification insert column
  (`link_entity_type`/`link_entity_id`/etc.) exists on `NotificationsRow`.
- Route wiring is correct: `../handler` resolves from
  `app/api/invitations/[id]/route.ts` (the spec sample's `../../handler` was
  wrong for this depth; the coder's deviation is justified and tsc confirms it).
- Migration `20260712000002_...` copies the precedent enum-add migration shape
  and sorts after `20260712000001`.
- Tests are meaningful, not superficial: they assert status/error codes, the
  exact update payload (and that `responded_at` is absent), the notification
  target/type, the audit RPC action+metadata, and that no Supabase client is
  even constructed on the 403/401 short-circuits. Failure branches
  (lookup error, notify-insert error) are exercised and return 500.
- Scanned the commit for network/exec/beacon patterns (given prior repo
  incidents) — none present. Diff is scoped to issue #43.

## Non-blocking notes for the human / orchestration

1. The Testing stage's supplement file
   `tests/unit/app/api/invitations-withdraw-route-tester-supplement.test.ts`
   is UNTRACKED and not part of commit `af03ca6`. It currently runs green
   (it is picked up by Jest from the working tree), but it will NOT ship with
   the PR unless committed. Its coverage (guest→403, update-query-error→500,
   update-no-row→404, and a `.eq(...)` scoping regression guard that asserts no
   `user_id` filter is applied) is valuable — recommend committing it before the
   PR is opened. The committed suite already covers the core paths, so this is
   an enhancement, not a correctness gap.
2. `writeAuditLog`'s result is awaited but not error-checked (audit failure
   would not 500). This is consistent with the spec (step 8 does not require it)
   and with the sibling handlers, so it is intentional and not a defect.
3. Withdrawing an already-`withdrawn`/`denied`/`accepted`/`expired` invitation
   returns 409 rather than being idempotent — a documented, deliberate
   divergence from `denyInvitation` (spec Decision 1). Correct as specified.
