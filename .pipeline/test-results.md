# Test Results — Issue #25: Join church group via invite code (`POST /api/church-group/join`)

Independently re-verified (not just trusting `changes.md`'s claims).

## Automated checks (re-run independently)

| Check | Result |
|---|---|
| `bun install` | OK (707 packages) |
| `bun run typecheck` | **PASS** — no errors |
| `bun run lint` | **PASS** — no errors |
| `bun run test` | **PASS** — 6 suites / 40 tests, 0 failures (includes the 11 tests in `tests/unit/app/api/church-group-join-route.test.ts`) |
| `bun run check:service-role` | **PASS** — no service-role key references in `app/`/`lib/` |
| `bun run format:check` | Pre-existing warnings only, in files untouched by this change (`README.md`, `supabase/README.md`, `tests/integration/rls/**`). None of the files changed for #25 are flagged. Matches the coder's claim. |

## Manual/functional verification of the migration (the gap flagged by the coder)

`changes.md` explicitly flagged that the expiry-check branch in `join_church_group()` has no unit-test coverage (unreachable from mocked-RPC tests) and asked the tester to exercise it if a live DB were available. A live DB was not set up in this environment, but Docker was available, so I spun up a throwaway Postgres 16 container, stubbed a minimal `auth.jwt()` (reading `request.jwt.claims` via `current_setting`, matching how Supabase exposes the JWT to `SECURITY DEFINER` functions) and the `authenticated`/`anon` roles, then applied all 11 migrations in lexicographic order, including the new `20260706000002_church_group_join_rpc.sql`.

- **All 11 migrations applied with zero SQL errors**, confirming the new migration (the `ALTER TABLE ... ADD COLUMN invite_code_expires_at` and the `CREATE FUNCTION public.join_church_group` + `GRANT`) is syntactically valid and consistent with the existing schema.
- Ran `join_church_group(...)` directly against seeded `church_groups` rows, simulating the joiner's Clerk `sub` via `set_config('request.jwt.claims', ...)`:
  - **Happy path**: valid, non-expired invite code → returns the new `users` row with `role = 'member'`, correct `church_group_id`. PASS.
  - **Already-in-group**: same clerk id joining a second time → raises `USER_ALREADY_IN_GROUP` (P0001). PASS.
  - **Unknown invite code**: raises `INVALID_INVITE_CODE` (P0001). PASS.
  - **Expired invite code** (`invite_code_expires_at` in the past) — the previously-untested branch — raises `INVALID_INVITE_CODE` (P0001), identical to the unknown-code case, exactly as the spec's human-resolved override requires. **PASS.**
  - **Unauthenticated** (no `sub` in JWT claims) → raises `UNAUTHENTICATED` (P0001). PASS.
  - **Future expiry (not yet expired)**: code with `invite_code_expires_at` in the future still allows a successful join. PASS — confirms future timestamps (and by extension NULL) don't false-positive as expired.
- Container was torn down after the run; no persistent state left behind.

This closes the one gap the coder called out — the expiry/revocation branch is now confirmed to behave correctly, not just "reviewed by eye against conventions."

## Code review of changed files (cross-checked against spec.md + changes.md)

- `supabase/migrations/20260706000002_church_group_join_rpc.sql` — matches spec's RPC pattern (auth check, already-in-group check, invite-code lookup, insert-and-return) plus the human-approved addition of `invite_code_expires_at` and the expiry check. Commented DOWN block present and correctly ordered (drops function, then column). `SECURITY DEFINER` / `SET search_path = ''` / `RAISE EXCEPTION ... USING ERRCODE = 'P0001'` conventions match `20260706000001_church_group_create_rpc.sql` exactly.
- `schemas/church-group.ts` — `joinChurchGroupSchema` appended exactly as specified (`inviteCode: z.string().trim().toUpperCase().min(1).max(20)`); `createChurchGroupSchema` untouched.
- `app/api/church-group/join/route.ts` — flow, error-code mapping, and status codes match spec section 3 exactly (401 no `clerkId` / 401 no JWT / 400 schema failure without calling `getSupabaseClient` / RPC call with exact param names / error-message substring mapping for `INVALID_INVITE_CODE` → 400, `USER_ALREADY_IN_GROUP` → 409, `UNAUTHENTICATED` → 401, else 500 / success → `ok(data, 201)` / outer try/catch → 500). `deriveMemberName` mirrors `deriveCreatorName` with `"Member"` fallback instead of `"Admin"`, truncated to 100 chars, verbatim otherwise.
- `lib/supabase/types.ts` — `join_church_group` Functions entry matches the RPC signature (`Args` with `p_invite_code`/`p_member_name`/`p_member_email`, `Returns: UsersRow`); existing `create_church_group` entry and row shapes untouched. `bun run typecheck` confirms the `.rpc("join_church_group", ...)` call in the route compiles.
- `app/(public)/join/[code]/page.tsx` + `join-form.tsx` — thin server component unwraps `Promise<{ code }>` params, client component POSTs `{ inviteCode: code }` and shows an in-place "you're in" success state (no redirect) on 2xx, renders the `error` string on non-2xx. This is consistent with the human-resolved override of spec's OPEN QUESTION #2 (the spec's own stub assumption of a `/profile` redirect via `useRouter().push` was explicitly overridden by a documented human decision in `changes.md`, deferring the redirect to issue #16) — a deliberate, documented scope decision, not a missed requirement.
- `tests/unit/app/api/church-group-join-route.test.ts` — covers all 11 required cases from spec section 6 (201 happy path with exact rpc-arg assertions, uppercase/trim normalization, 400 INVALID_INVITE_CODE, 400 missing/empty inviteCode, 400 non-JSON/empty body, 409 USER_ALREADY_IN_GROUP, 401 no userId, 401 no JWT, 500 generic rpc error, 500 currentUser() rejects, "Member"/null fallback). All pass; `getSupabaseClient` correctly asserted as not-called on the auth/validation-failure paths.

## Verdict

**PASS.** All automated checks (`typecheck`, `lint`, `test`, `check:service-role`) pass and match the coder's claims. The migration was independently applied to a real Postgres 16 instance (not just reviewed by eye), and the RPC's behavior — including the previously-untested expiry/revocation branch — was functionally verified end-to-end and behaves exactly as `spec.md`'s human-resolved override describes. No discrepancies found between `changes.md`'s claims and the actual code/behavior. No failures found. Ready for Reviewer.
