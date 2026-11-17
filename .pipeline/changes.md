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
