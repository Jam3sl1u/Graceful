# Review — Issue #26: Member directory endpoint (`GET /api/church-group/members`)

## VERDICT: SHIP

## What I verified independently
- Ran `git diff main...HEAD` — only 4 files touched: the route, `lib/supabase/types.ts`,
  the new unit test, and `.pipeline/changes.md`. No out-of-scope files (member `[id]`
  stubs, migrations, UI) changed.
- `bun run typecheck` — clean. `bun run lint` — clean. `bun run test` — 6 suites /
  42 tests pass.
- Cross-checked the hand-written Supabase types against the actual migrations:
  - `member_profiles` (cluster_1): `id, user_id (unique), vocal_capability, bio, created_at`
    — matches `MemberProfilesRow` exactly.
  - `instruments` / `member_instruments` (cluster_2): `member_instruments` has a real
    `id uuid primary key`, plus `member_profile_id`, `instrument_id` — matches
    `MemberInstrumentsRow`. `is_default`, `created_by` on `instruments` confirmed.
  - `vocal_capability` enum = `'none'|'lead'|'harmony'|'both'` — matches `VocalCapability`.

## Correctness
- Handler order matches spec: `requireAuth` -> `requireRole(["admin","set_leader","member"])`
  -> `getToken` (401 if no JWT) -> 4 parallel group-scoped queries -> 500 on any `.error`
  -> in-JS assembly -> `ok({ members })`. Guest is rejected (403) before any DB access.
- Contact-detail gating is server-side and correct: `email`/`phone` are only assigned when
  `ctx.role === "admin"`, so the keys are genuinely absent (not `null`) for non-admins. The
  test asserts this via `"email" in member`, which is the right check since `NextResponse.json`
  strips `undefined` — this is the security-critical AC-2 behavior and it holds.
- Defense-in-depth `.eq("church_group_id", ctx.churchGroupId)` applied on `users` and
  `instruments` (the tables that carry the column), on top of RLS (AC-3).
- Edge cases handled correctly: no-profile user -> `'none'` / `[]` and still listed;
  profile-with-no-instruments -> `[]`; dangling `instrument_id` skipped via `if (!name) continue`;
  `availabilityStatus: null` placeholder with #34 comment.

## Tests
- Meaningful, not superficial. Coverage includes both branches of the admin gate, the
  guest 403, no-JWT 401, no-Clerk 401 (lookup asserted not called), instrument mapping,
  the dangling-instrument skip, the no-profile fallback, single-member group, and the 500
  path. Assertions check body shape and key presence, not just status codes.

## Minor notes (non-blocking)
- The handler calls `auth()` a second time for `getToken` (once inside `requireAuth`, once
  in the handler). This is redundant but is exactly the pattern the spec prescribed and
  mirrors `lookupUserByClerkId`; no correctness impact.
- Non-admin callers cannot see their own contact info either. This matches the spec ("ONLY
  when caller is admin") — flagging only so it's a conscious product choice, not a bug.

Nothing to fix. Ship it.
