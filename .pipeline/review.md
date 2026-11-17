# Review — Issue #208 (P2-01 chat tables + RLS)

VERDICT: NEEDS WORK

## Scope of what was reviewed
- Real PR diff = `origin/main...HEAD` = single commit fd1484f (10 files). NOTE: local `main` in this
  repo is stale (b0ac73c, behind origin/main), so `git diff main...HEAD` shows 44 files, most of them
  already-merged #82/#69/etc. work. Those are NOT part of this PR. Reviewers should diff against
  `origin/main`.
- Read: spec.md, changes.md, test-results.md, the new migration, types, seed/setup, both RLS test
  files, the static unit test; cross-checked against `20260704000001_rls_policies.sql`,
  cluster 1/3 DDL, and PRD v10 §20.7 / feature tables.
- Re-ran myself: `bun run typecheck` (pass), `bun run lint` (pass), the new static unit test (15/15 pass).

## What is good
- Migration matches the spec almost line for line: enum, 3 tables, named char_length CHECK, circular
  pin FK (ON DELETE SET NULL, added after both tables), both indexes, `is_chat_room_member`
  (SECURITY DEFINER, `search_path = ''`, STABLE, COALESCE→false), RLS enabled, every policy as
  specified, no DELETE policies, fully commented DOWN block, no `create table` phrase in comments.
- No unqualified-column capture in correlated subqueries (checked `service_weeks`, `chat_messages`,
  `chat_rooms`, `users` columns). No policy recursion cycle: the only cross-table policy references go
  through the SECURITY DEFINER helper (owner bypasses RLS), consistent with the auth_* helpers.
- Types/seed/setup changes are correct and in sync; no existing seed rows/IDs changed; applied
  migrations untouched. Pipeline reporting is honest about what was NOT RUN.

## What must be fixed before SHIP

1. **The SQL has never been executed. Not once.** No `psql`/Postgres, `bun run test:rls` skipped all
   12 suites, and none of the 14 chat RLS cases or the 22 cross-tenant chat cases have run. For an
   issue whose whole deliverable is DDL + RLS behavior, "typecheck + static regex test passes" is not
   verification. Fix: `supabase start` (CLI is at /opt/homebrew/bin/supabase, Docker is installed),
   apply all migrations, run `bun run test:rls` with the SUPABASE_TEST_* vars, and record actual
   pass/fail per chat case in test-results.md (keep N3 separate). If anything fails, fix the migration.

2. **The D2 membership gate can be bypassed via pre-existing `invitations_update_own`.**
   `20260704000001_rls_policies.sql:284-287` lets an invitee UPDATE *any column* of their own
   invitation row. WITH CHECK only pins `church_group_id` and `user_id`. Because
   `is_chat_room_member` trusts `invitations.status = 'accepted'` and `service_week_id`, any
   same-church user who holds any invitation row, even a denied or withdrawn one, can PATCH it
   directly through PostgREST (URL and anon key are NEXT_PUBLIC, and the user's Clerk JWT is
   accepted) to
   `{status:'accepted', service_week_id:<any week>}` and read/write that week's chat. This directly
   falsifies the spec's edge case "withdrawn invitation revokes access immediately" and the header's
   "pending, denied and withdrawn invitees are not members". The root cause predates this PR, but
   this PR is what turns it into a chat-confidentiality hole (same tenant only, no cross-church
   leak). Fix (one of these; it needs an operator call because it touches the invitations table):
   (a) in this migration, constrain invitee-side updates (for example, a BEFORE UPDATE trigger that,
   when the caller is not leader/admin, forbids changing service_week_id/church_group_id/user_id and
   only allows pending→accepted/denied), with RLS tests for both the withdrawn→accepted and
   re-pointed-week attacks; or (b) have the operator explicitly accept the risk, open a tracked
   follow-up issue, and state it in the PR body. Do not ship silently.

3. **`chat_messages_update_own` lets the author rewrite any column, not just soft-delete.** The spec
   calls it "the soft-delete path", and the PRD says "Soft-delete only" and "chat messages retained
   indefinitely". As written, an author can:
   - overwrite `content` (for example with `''`), which destroys retained data without `is_deleted`
   - backdate `created_at`
   - change `kind`/`metadata`
   - move a message to another room they belong to by changing `chat_room_id`. If that message is
     pinned, the source room's `pinned_message_id` then points at another room's message, which
     breaks the same-room pin invariant that `chat_rooms_update_leader_admin` enforces.

   Fix: in the migration add
   `REVOKE UPDATE ON public.chat_messages FROM authenticated, anon;` then
   `GRANT UPDATE (is_deleted) ON public.chat_messages TO authenticated;`. This uses column privileges;
   the existing repo precedent is the audit_logs REVOKE in cluster6. Add an RLS test that an author
   UPDATE of `content` / `chat_room_id` errors or is a no-op, and a static assertion for the grant. If
   the operator wants message editing, that is a spec change, not a default.

4. **Test assertions that can pass without proving anything** (`tests/integration/rls/tables/chat.test.ts`):
   - Case 12, last block: the service-client mention insert's error is ignored, and the check is
     `expect(data ?? []).toHaveLength(0)` with no positive control. If the insert failed or the query
     errored, it passes anyway. Assert the svc insert succeeded, and assert memberA *can* see that
     mention before asserting memberA2 sees zero.
   - Case 14: the errors from the pin update and the mention upsert are ignored. If either fails, the
     circular-FK cascade (the whole point of the case) is never exercised. Assert both succeeded, and
     read back that R5.pinned_message_id = M5 before deleting W5.
   - Case 8 / 11: assert `error` is null on memberA's soft-delete and leaderA's first pin (11 does
     this; 8 does not).
   - Add the spec edge cases that are untested: a `withdrawn` invitee is not a member, and a user with
     multiple invitations for one week (one accepted) is a member.

## Non-blocking notes (no change required)
- Mentions: an author can mention a same-church user who is not a member of the room. The mention row
  is invisible to them via RLS, but the later `chat_mention` notification dispatch must re-check
  membership, or it will leak message content. Carry this into that issue.
- D2 makes every admin/set_leader a member of every room. PRD §"Per-week group chat" says "all
  confirmed members and the worship leader". This is an operator decision, so it is accepted, but it
  is broader than the PRD's wording.
- N3 (pre-existing PHASE1_TABLES coverage-pin failure) now drifts by 3 more tables; worth a
  follow-up issue.
- `.pipeline/test-results.md` is modified but uncommitted in the worktree.
