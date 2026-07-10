# Spec — Issue #28: Remove/archive member with PII anonymization

Implements `DELETE /api/church-group/members/:id` (Admin only): a right-to-erasure
pattern, not a hard delete. PII is anonymized in place; historical setlist/scheduling
participation is retained in anonymized form (PRD §25.6); BR-12 (never leave a church
group with zero admins) is extended to removal; the action is written to the audit log.

This spec replaces the stale carryover from the prior pipeline run, which described
the already-merged Issue #37 (Service Week CRUD) and produced no code for #28. See
the approved plan at `.claude/plans/issue-28-description-fancy-beacon.md` for full
exploration/design rationale; this file summarizes the resulting implementation.

## Key finding

`invitations.user_id` and `event_attendees.user_id` are `ON DELETE CASCADE` to
`users`. A real `DELETE FROM users` would destroy exactly the historical
participation data the issue requires to survive. Removal must be an UPDATE that
anonymizes the row in place (same `users.id`), never a DB-level delete.

Several tables that need clearing for another user (`notification_preferences`,
`notifications`, `google_calendar_tokens`) have RLS policies scoped to the row's
own user only — an admin's plain RLS-scoped client cannot clear them for someone
else. Combined with BR-12 needing an atomic last-admin check (to avoid a TOCTOU
race between two concurrent admin removals), the whole operation runs as one
atomic `SECURITY DEFINER` RPC, `remove_church_group_member`, mirroring the shape
already used by `POST /api/church-group/join` (`join_church_group`).

## Design decisions

- **Access revocation lever**: every RLS policy resolves identity via
  `clerk_id = auth.jwt()->>'sub'`, so `clerk_id` (not `role`) is what actually
  gates access. Set to a unique non-matchable placeholder: `'deleted-' || id`.
- **Anonymized fields**: `name = 'Deleted User'`, `email = NULL`, `phone = NULL`,
  `sms_opted_in = false`, `role = 'guest'`, `anonymized_at = now()` (new marker
  column).
- **`member_profiles`**: hard-deleted (cascades `member_instruments`).
- **Future-schedule cleanup**: `availability`, `notification_preferences`,
  `notifications`, `google_calendar_tokens` rows deleted for the user.
  `invitations`, `event_attendees`, `setlists.created_by`, `events.created_by`,
  `service_weeks.created_by`, `conflicts.*` are left untouched — these point at
  the now-anonymized `users.id` and are the "historical participation" the
  issue requires to retain.
- **BR-12 for removal**: checked only when the target's current role is
  `'admin'`; implemented independently inside the RPC (not shared with
  `role/handler.ts`'s TS-side demote guard — different execution boundary).
  Locking uses a single `ORDER BY id FOR UPDATE` query over `{target} ∪
  {current admins in the group}` to avoid a cross-lock deadlock between two
  concurrent admin removals while still closing the TOCTOU race that a bare
  `COUNT(*)` would leave open.
- **Directory listing**: `app/api/church-group/members/handler.ts`'s roster
  query adds `.is("anonymized_at", null)`.
- **Idempotency**: re-DELETE on an already-anonymized member returns 404, not
  a no-op 200 (confirmed with the user).
- **Response**: `200` with `ok({ id: targetUserId })`.
- **Audit log**: `{ action: "member.removed", entityType: "user", entityId,
  metadata: {} }` — metadata deliberately empty so the removed member's
  pre-anonymization PII isn't captured into the (append-only, long-retained)
  audit log.
- **Out of scope**: Clerk Backend API identity deletion (breaking `clerk_id`
  is sufficient to revoke app access; no code elsewhere calls the Clerk
  Backend API).

## Files changed

1. `supabase/migrations/20260710000001_member_removal_rpc.sql` — `anonymized_at`
   column + `remove_church_group_member` RPC.
2. `lib/supabase/types.ts` — `sms_opted_in`, `anonymized_at` on `UsersRow`;
   `remove_church_group_member` RPC entry.
3. `app/api/church-group/members/[id]/route.ts` — DELETE wrapper (was a stub).
4. `app/api/church-group/members/[id]/handler.ts` — new `deleteMember`.
5. `app/api/church-group/members/handler.ts` — roster query excludes
   anonymized users.
6. `tests/unit/app/api/church-group-members-id-route.test.ts` — new.
7. `tests/unit/app/api/church-group-members-route.test.ts` — new assertion for
   the `anonymized_at` filter.
8. `tests/integration/rls/tables/member-removal.test.ts` — new; first RPC
   integration test in the repo, including a real concurrent-removal race
   test against a live Postgres instance.
