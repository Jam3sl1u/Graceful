# Changes — #22 RLS Policies on Every Phase 1 Table

## Files created

| File | What it does |
| ---- | ------------ |
| `supabase/migrations/20260704000001_rls_policies.sql` | Defines 4 SECURITY DEFINER helper functions (`auth_user_id`, `auth_church_group_id`, `auth_user_role`, `auth_is_leader_or_admin`); drops the bootstrap `users_select_own` policy; enables RLS on all 17 remaining tables; creates ~70 policies across all 18 tables using tiered rules (tenant isolation, published-only setlists, own-row availability, role-gated invitations/conflicts/audit_logs, user-scoped tier-3 tables). Full commented DOWN block. |
| `supabase/seed-rls-test.sql` | Deterministic-UUID seed for 2 isolated test tenants (Church A + B): 7 users, instruments, service weeks, draft + published setlists, songs, setlist songs, events, invitations, conflicts, availability, notifications, notification prefs, audit logs, gcal tokens, song documents. TRUNCATE cascade + re-insert = idempotent. |
| `tests/integration/rls/jwt.ts` | Mints HS256 Supabase-compatible JWTs signed with `SUPABASE_JWT_SECRET`. Sets `sub` = `clerk_id` so helpers resolve identity via DB fallback (no Clerk required in tests). Optionally injects `church_group_id` or app-role claim to test JWT fast path. |
| `tests/integration/rls/client.ts` | `getServiceClient()` (bypasses RLS, for seed/teardown) and `getUserClient(claims)` (anon-key + minted JWT, subject to RLS). |
| `tests/integration/rls/setup.ts` | Exports `IDS` constants (all deterministic UUIDs), env-guard flag `rlsTestsEnabled`, `globalSetup()`, and `seedViaServiceClient()` for programmatic seeding. |
| `tests/integration/rls/tables/cross-tenant.test.ts` | Parameterized cross-tenant isolation: Church B member cannot SELECT/INSERT Church A rows across all Tier 1/2 tables. |
| `tests/integration/rls/tables/setlists.test.ts` | Published/draft visibility: member/guest cannot see drafts; leader/admin can; setlist_songs inherits parent visibility. |
| `tests/integration/rls/tables/role-gated.test.ts` | Invitations (member sees own only; leader inserts), conflicts (leader/admin only), audit_logs (admin only). |
| `tests/integration/rls/tables/availability.test.ts` | Own-row writes: member can only INSERT/UPDATE own rows; leader/admin any row in group. |
| `tests/integration/rls/tables/users.test.ts` | Member directory SELECT; INSERT denied for authenticated; UPDATE own row vs. leader/admin update others; admin DELETE. |
| `tests/integration/rls/tables/tier3-user-scoped.test.ts` | notification_preferences and google_calendar_tokens: strict user_id = auth_user_id() for all ops. |
| `jest.config.integration.ts` | Standalone Jest config for `bun run test:rls` — targets `tests/integration/rls/**/*.test.ts`, `testTimeout: 30s`, `maxWorkers: 1`. |

## Files modified

| File | What changed |
| ---- | ------------ |
| `jest.config.ts` | Reverted to single-project unit-test config (no integration project); `testPathIgnorePatterns` now explicitly excludes `tests/integration/`. This keeps `bun run test` fast and DB-free. |
| `package.json` | `test:rls` script updated to `jest --config jest.config.integration.ts`; `jsonwebtoken` + `@types/jsonwebtoken` installed as devDeps. |
| `.github/workflows/ci.yml` | Added `rls-integration` job (conditional on `SUPABASE_TEST_URL` secret) that applies all migrations via psql then runs `bun run test:rls`. |
| `supabase/README.md` | Added `20260704000001_rls_policies.sql` migration row; added "RLS Integration Tests" section with local dev + CI workflow; removed #22 from roadmap. |
| `lib/api/auth.ts` | Removed `TODO(#22)` comment; replaced with note that full policies are live. |

## Test results

```
# Unit tests (no DB required)
bun run test
→ Test Suites: 4 passed, 4 total
→ Tests:       17 passed, 17 total

# Integration tests (skipped without Supabase env)
bun run test:rls
→ Test Suites: 7 skipped, 0 of 7 total
→ Tests:       136 skipped, 136 total
```

TypeScript: `bun run typecheck` → 0 errors.

## Tester focus areas

- **Migration syntax**: Apply `20260704000001_rls_policies.sql` on a fresh Supabase instance with `supabase db push` and verify no SQL errors.
- **SECURITY DEFINER helpers**: Verify no infinite recursion when `auth_church_group_id()` is called in policies on the `users` table.
- **Cross-tenant isolation**: Set `SUPABASE_TEST_URL` + secrets, run `bun run test:rls` — every `cross-tenant.test.ts` assertion must pass.
- **Published/draft setlists**: `setlists.test.ts` — member must NOT see draft; leader/admin must see draft.
- **audit_logs**: Admin SELECT; leader cannot; member cannot.
- **availability own-row**: Member can only write own rows; leader can write any.
- **JWT fast path**: `rls.test.ts` "JWT claims fast path" describe block — client with explicit `churchGroupId` claim routes through `COALESCE` fast path instead of DB lookup.

## Local dev workflow

```bash
supabase start
supabase db push
export SUPABASE_TEST_URL=$(supabase status --output json | jq -r '.api.url')
export SUPABASE_TEST_ANON_KEY=$(supabase status --output json | jq -r '.anon_key')
export SUPABASE_TEST_SERVICE_ROLE_KEY=$(supabase status --output json | jq -r '.service_role_key')
export SUPABASE_JWT_SECRET=$(supabase status --output json | jq -r '.jwt_secret')
bun run test:rls
```
