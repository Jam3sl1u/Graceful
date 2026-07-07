# Review — Issue #25: Join church group via invite code

VERDICT: SHIP

## Summary
The implementation faithfully mirrors the established `PUT /api/church-group` (issue #24) pattern and satisfies the spec, including the two human-resolved OPEN QUESTION overrides documented in changes.md. Independently verified: `bun run typecheck`, `bun run lint`, and `bun run test` all pass (6 suites / 40 tests, incl. 11 new join-route tests).

## What I checked firsthand (git diff main...HEAD)

### Route — `app/api/church-group/join/route.ts`
- Auth flow, JWT check, schema parse-before-client, RPC call, error-message substring mapping, `ok(data, 201)`, and outer try/catch are byte-for-byte consistent with the create route. `deriveMemberName` is `deriveCreatorName` verbatim with the `"Admin"` → `"Member"` fallback swap and same 100-char truncation. Correct.
- `getSupabaseClient` is correctly NOT called on auth/JWT/validation failure paths (asserted in tests).

### Migration — `20260706000002_church_group_join_rpc.sql`
- Adds nullable `invite_code_expires_at` via `ALTER TABLE` (does not touch the create migration). This is a scope expansion beyond spec §1, but it is an explicitly documented human override, is backward-compatible (NULL = never expires, so all existing codes keep working), and reuses the existing `INVALID_INVITE_CODE` → 400 mapping so no route copy changes were needed. Acceptable.
- `SECURITY DEFINER`, `SET search_path = ''`, `RAISE ... USING ERRCODE = 'P0001'`, `GRANT EXECUTE ... TO authenticated`, and commented DOWN block all match `20260706000001` conventions. DOWN correctly drops function then column.
- Ordering is sound: auth → already-in-group → code lookup → expiry → insert. The unique `clerk_id` constraint backstops the explicit already-in-group check under concurrency (worst case a generic 500 on a race — acceptable).

### Schema / types
- `joinChurchGroupSchema` = `z.string().trim().toUpperCase().min(1).max(20)` exactly as specified; `createChurchGroupSchema` untouched.
- `join_church_group` Functions entry added with correct Args/`Returns: UsersRow`; typecheck confirms the `.rpc()` call compiles.

### Client — `page.tsx` + `join-form.tsx`
- Thin server component unwraps `Promise<{ code }>` and delegates to a `"use client"` form. On 2xx shows in-place success (no redirect); on non-2xx renders the `error` string with `role="alert"` (satisfies AC #2 messaging). The no-redirect behavior deviates from the original AC #4 wording but is an explicit, documented human override deferring the profile-completion redirect to issue #16. Flagged, not blocking.

### Tests — `church-group-join-route.test.ts`
- All 11 spec-required cases present and meaningful (not superficial): exact rpc arg assertions, uppercase/trim normalization, each error-code branch, and `getSupabaseClient` not-called assertions on the short-circuit paths. Mocking mirrors the create-route test style.

## Notes (non-blocking)
- The RPC expiry branch is not reachable from the mocked-RPC unit tests, but the Tester exercised it against a real Postgres 16 container (unknown/expired/future/happy/already-in-group/unauthenticated paths all confirmed). Acceptable coverage.
- `error.message.includes(...)` matching is only validated against mocked error shapes, same caveat as #24. Fine to carry forward.
- AC #4's redirect is intentionally deferred to #16 — confirm this is the intended product decision at merge time.

No security, correctness, or performance issues found. Ship.
