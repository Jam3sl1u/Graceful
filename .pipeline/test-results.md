# Test Results — Issue #26: Member directory endpoint (`GET /api/church-group/members`)

## Verdict: PASS

## What was independently verified

- `bun install` — succeeds, no lockfile drift.
- `bun run typecheck` (`tsc --noEmit`) — passes, no errors.
- `bun run lint` (`eslint .`) — passes, no errors/warnings.
- `bun run test` (`jest`) — **6 suites / 42 tests pass** (38 tests from the coder's
  original submission + 4 additional edge-case tests I added below). No failures,
  no skipped tests.

I read the implementation (`app/api/church-group/members/route.ts`) and the extended
`lib/supabase/types.ts` line-by-line against `.pipeline/spec.md` and cross-checked
against the reference patterns it claims to follow (`app/api/_examples/admin-only/route.ts`,
`lib/api/auth.ts`). The coder's claims in `.pipeline/changes.md` check out:

- Handler order matches spec exactly: `requireAuth` -> `requireRole(["admin","set_leader","member"])`
  -> `auth().getToken({template:"supabase"})` -> 401 if no JWT -> 4 parallel group-scoped
  queries -> 500 on any error -> in-JS assembly -> `ok({ members })`.
- `email`/`phone` are added to the object only via `if (ctx.role === "admin") { member.email
  = ...; member.phone = ...; }` — genuinely omitted (not set to `undefined`) for non-admins,
  confirmed via `"email" in member` assertions in the test which pass.
- `vocalCapability: 'none'` / `instruments: []` default for users with no `member_profiles` row —
  confirmed by test and code inspection (`profile ? ... : "none"` / `profile ? ... : []`).
- `member_instruments` rows with no matching `instruments` row are skipped (`if (!name) continue`).
- No sorting/pagination/filtering added — matches spec's explicit "do not" instruction.
- `lib/supabase/types.ts` additions match the spec's field-by-field description exactly
  (`UsersRow` gains `name`/`email`/`phone`; new `member_profiles`, `instruments`,
  `member_instruments` tables with the specified columns); `lib/api/auth.ts` untouched and
  still typechecks.
- Out-of-scope items (member `[id]` stubs, UI, availability wiring, role assignment, member
  removal, new migrations) were confirmed untouched via `git status` — no unexpected files
  changed.

## Edge cases the spec named — coverage confirmed

- Guest caller -> 403 FORBIDDEN — covered (existing test).
- Unauthenticated, no Clerk session -> 401 UNAUTHENTICATED, lookup never called — covered
  (existing test).
- **Unauthenticated, Clerk session present but `getToken` resolves no JWT -> 401
  UNAUTHENTICATED** — not covered by the coder's original tests; I added this test
  (`"returns 401 UNAUTHENTICATED when getToken resolves no JWT..."`) and confirmed it passes
  against the current implementation.
- Non-admin caller (member/set_leader) -> no `email`/`phone` keys — covered (existing
  `it.each` test), verified the assertion is on key presence (`"email" in member`), not value,
  which is the correct approach since `NextResponse.json` drops `undefined` keys.
- Admin caller -> `email`/`phone` present, correct values including `null` for a user with no
  contact info on file — covered (existing test).
- User with no `member_profiles` row -> `vocalCapability: 'none'`, `instruments: []`, user
  still present — covered (existing test).
- **User with a profile but no `member_instruments` rows -> `instruments: []`** — not
  explicitly covered by the coder's original tests (only the "no profile at all" case was
  tested); I added this test and confirmed it passes.
- **`member_instruments` row whose `instrument_id` has no matching `instruments` row is
  skipped** — not covered by the coder's original tests; I added a test with a matching and a
  dangling instrument reference and confirmed only the matching one appears in the output.
- Every member has `availabilityStatus: null` — covered (existing test).
- Any of the four queries erroring -> 500 INTERNAL, no partial directory — covered (existing
  test, `users` query fails).
- **Caller is the only user in the group -> one-element array** — not covered by the coder's
  original tests; I added this test and confirmed it passes.
- Cross-group isolation (AC-3) — correctly deferred to `tests/integration/rls/` per spec; not
  a unit-test concern. Confirmed the handler does apply explicit `.eq("church_group_id", ...)`
  filters on `users` and `instruments` as defense-in-depth on top of RLS, matching spec step 4.

## Files touched during testing

- `tests/unit/app/api/church-group-members-route.test.ts` — added 4 tests (no-JWT 401,
  profile-with-no-instruments, dangling instrument reference skipped, single-member group).
  All other files are unchanged from the coder's submission.

## Conclusion

No failures found. The implementation matches the spec precisely, including all named edge
cases (the few gaps in the coder's original test coverage were supplementary/defensive and
are now closed). Recommend proceeding to review.

**Result: PASS. No blocking issues found. Ready for Reviewer.**
