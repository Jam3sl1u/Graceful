# Changes — Issue #208 (P2-01 chat tables + RLS)

## Files
- `supabase/migrations/20261116000001_chat_tables_rls.sql` (new): `chat_message_kind` enum, `chat_rooms`, `chat_messages`, `chat_mentions`, circular pin FK, two indexes, `is_chat_room_member()` (SECURITY DEFINER, D2 rule), RLS + policies per spec, commented DOWN block. No DELETE policies.
- `types/domain.ts`: added `ChatMessageKind`.
- `lib/supabase/types.ts`: hand-added Row/Insert/Update for three tables, `is_chat_room_member` function, `chat_message_kind` enum.
- `supabase/seed-rls-test.sql`, `tests/integration/rls/setup.ts`: Church B chat room/message/mention seed + new IDS groups; truncate lists extended. No existing rows/IDs changed.
- `tests/integration/rls/tables/cross-tenant-bypass.test.ts`: chat_rooms/chat_messages (memberA + adminA) and chat_mentions blocks.
- `tests/integration/rls/tables/chat.test.ts` (new): 14 spec cases with private fixtures (ID range `8016`).
- `tests/unit/supabase/chat-tables-migration.test.ts` (new): static migration checks.

## Verification
- `bun run lint`, `bun run typecheck`, `bun run test` (154 suites, 3248 tests) pass.
- NOT RUN: all chat RLS integration cases (`chat.test.ts`, chat blocks in cross-tenant matrix) — SUPABASE_TEST_* env vars absent.
- NOT RUN: applying the migration to a database (no local Postgres; `psql` absent). The SQL is unverified against a live DB.
- Pre-existing (N3): `phase1-token-bypass.test.ts` coverage-pin already fails on `main` (21 tables vs 19-entry list); untouched. Note it will now see 3 more tables.
- Spec source doc `documentation/phase-2/graceful_phase2_sprint_backlog.md` is missing (N1).

## Human steps
- Applying the migration to staging/production is a human step (carry into PR body).

## Tester focus
- Run `bun run test:rls` against a real Supabase: policy recursion, pin UPDATE WITH CHECK, mention insert policy, cascade with circular pin FK.

## Remediation round 1 (2026-11-16, after reviewer NEEDS WORK)

Operator decision in chat: fix review finding 2 in this PR rather than a separate issue.

- **Finding 2 — membership bypass via `invitations_update_own`.** New migration `supabase/migrations/20261116000002_invitations_invitee_update_guard.sql`: BEFORE UPDATE trigger on `invitations`. For a direct update by a non-leader `authenticated` caller, only `status`, `denial_reason`, `denial_count`, `responded_at` may change, and status may only go pending -> accepted or pending -> denied. Leaders/admins, the service role and the SECURITY DEFINER RPCs are unaffected. No applied Phase 1 migration edited; the Phase 1 test "member_a can UPDATE their own invitation (respond)" (pending -> accepted) is still a legal path.
- **Finding 3 — author could rewrite any message column.** In the chat migration: `REVOKE UPDATE ... FROM authenticated, anon` + `GRANT UPDATE (is_deleted) ... TO authenticated`, and `chat_messages_update_own` WITH CHECK now requires `is_deleted = true` (soft-delete is one-way).
- **Finding 4 — weak assertions.** `chat.test.ts` cases 8, 12, 14 now assert their setup writes succeeded and have positive controls. New cases 15 (soft-delete only), 16 (withdrawn invitee; several invitations with one accepted), 17 (guard blocks withdrawn/denied -> accepted, re-pointed week, forged columns), 18 (legal invitee, leader and service-role paths still work).
- Static test extended: column grant, WITH CHECK, and the guard migration's shape.

### Verification after round 1
- `bun run lint`, `bun run typecheck`, `bun run test` (154 suites, 3254 tests) pass.
- **Finding 1 is NOT resolved: the SQL has still never been executed.** No `psql`/Postgres on this machine; Docker is running but has no images, and pulling a Supabase stack was not authorised. `bun run test:rls`: 12 suites skipped (no SUPABASE_TEST_* vars), so all 18 chat cases and the cross-tenant chat blocks are NOT RUN. This is not a pass.
- `bun run test:rls` still shows the 1 pre-existing N3 failure, unchanged.

### Human steps
- Run `bun run test:rls` against a real Supabase with both migrations applied before merge.
- Apply both migrations to staging/production.

## Remediation round 2 (2026-11-16, after the independent second-pass review of round 1)

Operator decision in chat: fix the users privileged-column finding in this PR.

- **users role / church / login columns were writable by direct update.** New migration `supabase/migrations/20261116000003_users_privileged_column_guard.sql`: BEFORE UPDATE trigger on `users`. For direct `authenticated` updates, `id`, `clerk_id` and `church_group_id` are immutable and `role` can only be changed by an admin. Service role and SECURITY DEFINER RPCs unaffected. This is what the chat membership rule and the round 1 invitation guard rest on; round 1's "bypass closed" claim was not true without it.
- **Direct accept skipped `accept_invitation()`'s checks.** The invitation guard now allows only pending -> denied by direct update. One Phase 1 test (`tests/integration/rls/rls.test.ts`, "member_a can UPDATE their own invitation (respond)") is changed from accept to deny accordingly; this was the reviewer's preferred fix and was not separately confirmed by the operator.
- **Cross-tenant chat_messages UPDATE tests** now patch `is_deleted`, so they exercise the row policy again instead of failing on column privilege.
- **RPC coverage:** `chat.test.ts` case 18 now accepts and denies through `accept_invitation` / `deny_invitation`. New cases 19 and 20 cover the users guard (attacks, then positive controls).
- `lib/supabase/types.ts`: `chat_messages.Update` narrowed to `is_deleted`.

### Verification after round 2
- See `test-results.md` addendum. The SQL (now three migrations) has still never been executed; all RLS cases remain NOT RUN.
