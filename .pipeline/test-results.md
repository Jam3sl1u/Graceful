# Test results — Issue #208 (P2-01 chat tables + RLS)

## Verdict: PASS on everything runnable; RLS behavior and migration SQL are UNVERIFIED (NOT RUN)

## Independently re-run (Bun)
- `bun run lint`: pass
- `bun run typecheck`: pass
- `bun run test`: pass, 154 suites / 3248 tests (includes the new static test `tests/unit/supabase/chat-tables-migration.test.ts`)
- `bun run check:workflows`: pass

## NOT RUN (cannot be reported as passing)
- All chat RLS integration cases: `tests/integration/rls/tables/chat.test.ts` (14 spec cases) and the chat blocks in `cross-tenant-bypass.test.ts`. `bun run test:rls` shows 12 suites skipped because the SUPABASE_TEST_* env vars are absent.
- Applying the migration to a live Postgres. There is no `psql` or local Postgres. Docker is installed but has no images or containers, and I did not stand up a Supabase stack. The SQL was only read and statically checked, so syntax and semantics (policy recursion, pin UPDATE WITH CHECK, circular FK cascade) are unproven.

## Manual read of the migration against the spec
It matches the spec. Verified by reading:
- the enum, the three tables, the named 2000-char CHECK, and the circular pin FK with ON DELETE SET NULL
- both indexes
- `is_chat_room_member`: SECURITY DEFINER, `search_path = ''`, COALESCE to false, and the accepted-invitation or leader/admin rule
- RLS enabled on all three tables, with every policy as specified
- no DELETE policies
- a fully commented DOWN block

## Pre-existing failure (not introduced by this issue, N3)
- `phase1-token-bypass.test.ts` "PHASE1_TABLES exactly matches every table created in supabase/migrations" fails under `bun run test:rls`. The diff shows `practice_reminder_sends` and `app_secrets` are missing from its list. The chat tables will add 3 more to that diff. The file is untouched, as the spec directs.

## Reviewer action
- A human should run `bun run test:rls` against a real Supabase, with the migration applied, before merge.
- Applying the migration to staging/production is a human step.

## Remediation round 1 addendum (2026-11-16)
- Re-run after the fixes described in `changes.md`: `bun run lint` pass, `bun run typecheck` pass, `bun run test` pass (154 suites / 3254 tests; the static migration suite is now 21 tests).
- STILL NOT RUN: every RLS integration case, now 18 in `chat.test.ts` (new: 15 soft-delete-only, 16 membership edge cases, 17 and 18 invitee update guard), and both migrations against a live Postgres. The trigger's plpgsql and the column-privilege behaviour are unproven until a human runs `bun run test:rls` with the SUPABASE_TEST_* secrets.
- Pre-existing N3 failure unchanged.

## Remediation round 2 addendum (2026-11-16)
- Re-run after round 2: `bun run lint` pass, `bun run typecheck` pass, `bun run test` pass (154 suites / 3259 tests; the static migration suite now covers all three migrations).
- STILL NOT RUN: every RLS integration case (20 in `chat.test.ts`, the chat blocks in `cross-tenant-bypass.test.ts`, and the changed Phase 1 case in `rls.test.ts`), and all three migrations against a live Postgres. `bun run test:rls` skipped 12 suites for missing SUPABASE_TEST_* secrets. Both trigger functions and the column grant are unproven until a human runs it.
- Pre-existing N3 failure unchanged.
