# Changes — #15 auth DB lookup (post-#16)

## Files created

| File | What it does |
| ---- | ------------ |
| `supabase/migrations/20260703000001_users_self_read_rls.sql` | Bootstrap RLS slice (#22): enables RLS on `users`, adds `users_select_own` SELECT policy so auth lookup is safe before full #22 lands. Commented DOWN block follows #16 pattern. |
| `tests/unit/lib/api/lookup-user.test.ts` | Unit tests for `lookupUserByClerkId`: happy path, no row, Supabase error → 500, missing JWT → null. Mocks `@clerk/nextjs/server` `auth` + `@/lib/supabase/client` `getSupabaseClient`. |

## Files modified

| File | What changed |
| ---- | ------------ |
| `lib/supabase/types.ts` | Replaced `Record<string, never>` placeholder with hand-written `Database` type covering `users` table (`id`, `clerk_id`, `church_group_id`, `role`) and `user_role` enum. Shape satisfies supabase-js v2 `GenericSchema`/`GenericTable` so `from().select().maybeSingle()` returns typed data. |
| `lib/supabase/client.ts` | Replaced stub with server-only `getSupabaseClient(jwt)`: reads `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`, throws clear error if missing, passes JWT as `Authorization: Bearer` header. Anon key only — no service role key. |
| `lib/api/auth.ts` | Replaced `lookupUserByClerkId` stub: calls `auth().getToken({ template: "supabase" })` → queries `users` by `clerk_id` via `getSupabaseClient` → maps row to `AuthContext`. Returns null on missing JWT or no row; throws `ApiException` 500 on DB error. Removed `TODO(#16)`. Added `TODO(#22)` noting RLS bootstrap slice. Exported the function for unit testing. `UserLookup` injection seam unchanged. |
| `supabase/README.md` | Updated to reflect that migrations directory is no longer empty; documents both migration files and their purpose. |

## Test results

```
Test Suites: 4 passed, 4 total
Tests:       17 passed, 17 total
```

All pre-existing tests (`auth.test.ts`, `admin-only-route.test.ts`, `response.test.ts`) continue to pass. 4 new tests added in `lookup-user.test.ts`.

## Manual setup steps required (for PR description)

These are one-time dashboard actions — not code changes:

1. **Clerk JWT Template** — Clerk Dashboard → JWT Templates → New template → select *Supabase* preset → name it exactly `supabase` → Save. This wires `auth().getToken({ template: "supabase" })` to produce a JWT Supabase can verify.
2. **Supabase Third-Party Auth** — Supabase Dashboard → Authentication → Third-party auth → enable Clerk → paste your Clerk Frontend API domain (e.g. `https://<your-slug>.clerk.accounts.dev`). This makes `auth.jwt()` inside RLS policies resolve against Clerk's JWKS.
3. **Apply migrations** — `supabase db push` (or paste SQL into Supabase Dashboard SQL editor) to apply `20260703000001_users_self_read_rls.sql` on staging/prod.
4. **Smoke test** — seed a `church_groups` + `users` row with a real `clerk_id` matching a Clerk test user. Hit a route using default lookup; expect 401 with no row, 200/403 with row depending on role.

## Tester focus areas

- `lookupUserByClerkId` edge cases: no row, Supabase error, null JWT
- Verify injection seam still works (existing tests cover this)
- RLS policy correctness: `clerk_id = (auth.jwt() ->> 'sub')` — requires Clerk JWT template in place; test with `supabase db push` + seeded row
- Env var guard in `getSupabaseClient`: if `NEXT_PUBLIC_SUPABASE_URL` is unset, should throw clear error at call time (not silently)
