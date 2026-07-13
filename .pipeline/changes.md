# Changes — Issue #43: Withdraw invitation (`DELETE /api/invitations/:id`)

## Files changed

1. **`supabase/migrations/20260712000002_invitation_withdrawn_notification_type.sql`** (new)
   Adds `'invitation_withdrawn'` to the `notification_type` enum
   (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`), copying the shape of
   `20260711000001_service_week_notification_types.sql`. Sorts after
   `20260712000001_accept_invitation_rpc.sql`.

2. **`types/domain.ts`**
   Added `"invitation_withdrawn"` to the `NotificationType` union, placed
   right after `"invitation_denied"`.

3. **`app/api/invitations/handler.ts`**
   Added `withdrawInvitation(req, id, lookup?)`, placed after
   `denyInvitation`. Behavior:
   - `requireAuth` then `requireRole(ctx, ["admin", "set_leader"])` — 403 for
     any other role (e.g. `member`).
   - Fetches the Supabase JWT the same way `denyInvitation` does; 401 if
     missing.
   - Looks up the invitation scoped by `id` + `church_group_id` only (NOT
     `user_id` — the actor is withdrawing someone else's invitation). Query
     error → 500; not found → 404.
   - Non-`pending` status (accepted/denied/withdrawn/expired) → 409 CONFLICT,
     no side effects.
   - Updates the row to `{ status: "withdrawn" }` only — does **not** set
     `responded_at` (withdrawal is a leader action, not a member response).
     Update error → 500; missing row post-update → 404.
   - Inserts a `notifications` row targeting `inv.user_id` (the invited
     member, not the actor) with `type: "invitation_withdrawn"`. Insert
     error → 500 (not swallowed).
   - Writes an audit log via `writeAuditLog` with action
     `"invitation.withdrawn"` and metadata `{ service_week_id, user_id }`.
   - Leaves `// TODO(#45/#36): cancel any pending 24h reminders for this
     invitation.` — does not call `cancelReminder` (still a throwing stub).
   - Returns `ok({ invitation: toInvitationResponse(updated) })`.
   - Same `try/catch` → `ApiException` mapping pattern as the other handlers
     in this file.

4. **`app/api/invitations/[id]/route.ts`**
   Replaced the `notImplemented(...)` stub with a `DELETE` handler that
   awaits `params` and calls `withdrawInvitation(req, id)`, mirroring
   `app/api/invitations/[id]/deny/route.ts`. Note: the import is
   `from "../handler"` (one level up, matching this file's actual location),
   not `"../../handler"` as literally written in spec.md's code sample —
   the two-levels-up path does not resolve (`app/api/handler.ts` does not
   exist) and fails `tsc --noEmit`. Verified against `deny/route.ts`, which
   is one directory deeper and correctly uses `"../../handler"`.

5. **`tests/unit/app/api/invitations-withdraw-route.test.ts`** (new)
   Copies the mock scaffolding from `invitations-deny-route.test.ts`
   (`jest.mock` of `@clerk/nextjs/server` + `@/lib/supabase/client`,
   `makeReq`, `makeLookup`, `setUpAuth`, `makeChain`, `makeSupabaseClient`,
   `pendingInvitationRow`), extended with an `onInsert` hook to capture the
   notifications insert payload. Cases:
   - 403 FORBIDDEN for `member` role.
   - 401 UNAUTHENTICATED when no JWT.
   - 404 NOT_FOUND when invitation lookup returns null.
   - 409 CONFLICT for `accepted` status and for `denied` status (two cases).
   - 500 INTERNAL when the invitation lookup query errors.
   - Happy path: `pending` → `withdrawn`; asserts the update payload is
     exactly `{ status: "withdrawn" }` (`responded_at` explicitly asserted
     `undefined`); asserts the `notifications` insert targets
     `TARGET_USER_ID` with `type: "invitation_withdrawn"`; asserts the
     `write_audit_log` RPC call has `p_action: "invitation.withdrawn"` and
     the expected metadata.
   - 500 INTERNAL when the notification insert errors (not swallowed).

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean (after fixing the route.ts import path noted
  above).
- `bun run test` — 28 suites / 361 tests passed, including the 8 new cases
  in `invitations-withdraw-route.test.ts`.

## Notes for the Tester

- The migration file cannot be applied/verified against a live Postgres
  instance in this environment; it was checked structurally against the
  precedent migration (`20260711000001_service_week_notification_types.sql`)
  only. Confirm the enum value name and ordering if a DB is available.
- Out of scope, per spec: bulk withdrawal, reminder cancellation wiring
  (deferred to #45/#36 — comment only, `cancelReminder` not called), and
  unwinding `event_attendees` for accepted invitations (not applicable —
  withdrawal is only valid on `pending` invitations, which have no
  `event_attendees` rows yet).
- `.pipeline/spec.md` had unrelated leftover unstaged content in the working
  tree from a prior run (stale issue #42 spec) when this stage started; it
  now reflects the current issue #43 spec and is included in this commit
  for consistency with the rest of the pipeline artifacts.
