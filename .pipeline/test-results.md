# Test Results — Issue #80: Full auth-bypass & RLS-bypass test suite

## Verdict: PASS (with one non-blocking coverage gap noted below)

**Superseded in part — see "Reviewer fix-up follow-up" at the bottom.** This
report predates `.pipeline/review.md`'s NEEDS WORK verdict and the
subsequent fix-up pass; the coverage gap this report flagged (below) and the
review's separate BLOCKING finding have both since been addressed. The
original findings are left as written for the record; do not read this
file's numbers as current — see the follow-up section for the re-verified
counts.

All commands were re-run independently and cold in this worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-80`). All
claims in `.pipeline/changes.md` were spot-checked against actual handler
and migration source, not just trusted.

## Commands re-run

- `bun run lint` — **PASS**, no errors/warnings (`eslint .`).
- `bun run typecheck` — **PASS**, no errors (`tsc --noEmit`).
- `bun run test` — **PASS**: `112 suites, 2535 tests, 0 failures.` Matches
  the coder's claimed count exactly, run cold.
- `bun run test:rls` — **PASS**: `1 suite passed (2 tests), 11 suites
  skipped (294 tests)`. Confirmed no `SUPABASE_TEST_URL` /
  `SUPABASE_TEST_ANON_KEY` / `SUPABASE_TEST_SERVICE_ROLE_KEY` /
  `SUPABASE_JWT_SECRET` are set in this environment (`env | grep -i
  supabase` empty), and no local Supabase/Docker instance is reachable
  (`docker ps` fails — no daemon). Blocks B–E of
  `tests/integration/rls/tables/phase1-token-bypass.test.ts` and all of
  `cross-tenant-bypass.test.ts` did **not** execute here, matching spec
  Assumption 2 and the coder's own disclosure. This remains unverified
  beyond the mechanical coverage pin (block A) in this environment — flag
  for the Reviewer/human to run against a live local Supabase instance
  before treating AC-2's token-bypass claims as fully verified.
- New test files run in isolation for a closer look:
  `auth-bypass-matrix.test.ts` + `input-validation-injection.test.ts` +
  `middleware-rate-limit-matrix.test.ts` → **PASS**, 1220 tests, 3 suites.
- `phase1-token-bypass.test.ts` run directly against
  `jest.config.integration.js` → **PASS**: 2 passed (coverage pin), 60
  skipped (blocks B–D across 19 tables × 3, plus block E's 3), consistent
  with the skip-gate design.

## Scope check

- `git diff origin/main...HEAD --stat` confirms **no file under `app/`,
  `lib/`, `schemas/`, `middleware.ts`, or `supabase/` was touched** — only
  files under `tests/` (plus `.pipeline/*`). Matches spec Assumption 3.

## Independent verification of claims (not just trusted)

1. **AC-2 coverage-pin table count.** Cross-checked `PHASE1_TABLES` (19
   entries) against every `create table` / `CREATE TABLE` statement across
   `supabase/migrations/*.sql` (case-insensitive grep, since one migration
   uses uppercase DDL that a naive lowercase-only grep misses). Result: 19
   distinct tables, exact match. Also confirmed all 19 names literally
   appear in `cross-tenant-bypass.test.ts` (grepped each individually,
   5–8 occurrences each — not a coincidental substring match).

2. **`ADMIN_ROUTE_REGISTRY` escape-hatch entries — read the real handler
   source for every one, not just the registry's comments:**
   - `adminOnlyExample`, `google-calendar/connect` (`touchesSupabase:
     false`): confirmed via grep — neither calls
     `getSupabaseClient`/`getAnonSupabaseClient` anywhere in their files.
   - `google-calendar/callback` (`authFailureIsRedirect: true`): confirmed
     — every failure path in the handler goes through a blanket
     `redirectError()`/`try`/`catch`, never a JSON response.
   - `getAuditLog` (`ownScopeAssertion: false`): confirmed — its only
     `.from("audit_logs")...` query has no `.eq("church_group_id", ...)`;
     scoping is delegated entirely to RLS, as the registry comment claims.
   - `deleteMember` (`ownScopeAssertion: false`): confirmed — the RPC call
     is `supabase.rpc("remove_church_group_member", { p_target_user_id:
     targetUserId })`, no `church_group_id` argument.
   - `acceptInvitation` (`ownScopeAssertion: false`): confirmed — the RPC
     call is `supabase.rpc("accept_invitation", { p_invitation_id,
     p_response_token })`, no `church_group_id`/`userId` argument.
   - `GET /api/availability?user_id=<other>` (`ownScopeAssertion: false`):
     confirmed — the handler's `targetUserId = user_id` branch fully
     replaces `ctx.userId`; the query only ever filters by
     `targetUserId`, never a combined own-scope filter.

   All six spot-checked exceptions are accurate descriptions of real
   handler behavior, not weakened assertions dressed up with a
   rationalization.

3. **No hidden skips.** Grepped all four new/changed test files for
   `.skip`/`xdescribe`/`xit`/`it.todo` — the only hit is the intentional
   `describe.skip` RLS env-var gate in `phase1-token-bypass.test.ts`
   (`const describeRls = skip ? describe.skip : describe;`), which is the
   documented, spec-required behavior (Assumption 2), not a smuggled-in
   skip.

4. **Mutation sanity check attempted, then reverted.** I temporarily
   widened `createSongSchema.title`'s `.max(200)` to `.max(200000)` in
   `schemas/songs.ts` to confirm the Part A oversized-input assertion
   would actually catch a real regression (not a vacuous pass). The
   harness's own auto-mode classifier blocked the follow-up `bun run test`
   invocation specifically because it detected an uncommitted change to a
   file this issue is scoped to leave untouched (`schemas/`) — a good
   guardrail. I reverted the edit immediately
   (`git diff schemas/songs.ts` now empty, `git status` clean) and did not
   obtain a live before/after diff of the sweep failing. This is a gap in
   *my own* verification depth, not a defect in the suite; the direct
   source-level spot checks in item 2 above still substantiate that the
   registry's assertions are load-bearing.

## Finding: Part A schema sweep does not enumerate every exported schema's string fields

Spec §5 Part A says: "Build a table of `{ label, schema, field, max, trims,
baseValid }` for every string field of every exported Zod object schema in
`schemas/*.ts`." Reading every file under `schemas/*.ts` directly and
diffing against `FIELD_CASES` in
`tests/unit/schemas/input-validation-injection.test.ts`, four
gaps remain:

- `schemas/events.ts` → `updateEventSchema` (`name`, `location`, `notes`)
  is exported but never appears in `FIELD_CASES` — only its sibling
  `createEventSchema` is swept. (`updateEventSchema` does have separate,
  pre-existing max-length-only tests in `tests/unit/schemas/events.test.ts`
  and `events-notes-max-tester-supplement.test.ts`, but neither runs the
  SQLi/XSS/null-byte/Unicode `ALL_PAYLOADS` corpus against it.)
- `schemas/service-weeks.ts` → `updateServiceWeekSchema` (`title`,
  `sermonTopic`, `sermonScripture`, `speakerName`) — same situation:
  exported, has identical field validators to
  `createServiceWeekSchema`, but not in `FIELD_CASES`. Pre-existing
  max-length-only tests exist in `tests/unit/schemas/service-weeks.test.ts`,
  again without the adversarial corpus.
- `schemas/setlists.ts` → `reorderSetlistSchema`'s array-item `notes`
  field (`.trim().max(1000)`) is not tested anywhere in the repo — not in
  this new sweep, not in any pre-existing test file I could find
  (`grep -rn "reorderSetlistSchema" tests/`).
- `schemas/songs.ts` → `createSongSchema.tags` (`z.array(z.string().trim()
  .min(1).max(50))`) — the array-of-strings field is entirely absent from
  the sweep.

None of these caused an actual production bug in this run — the `update*`
schemas literally copy-paste the same `.trim().min().max()` chain as their
`create*` counterparts, so the risk of an undetected divergence is low
today — but `reorderSetlistSchema.notes` and `createSongSchema.tags` have
**zero** adversarial-payload coverage anywhere in the repo, which is a real
gap relative to the "every string field of every exported Zod object
schema" claim in `.pipeline/changes.md`'s own "What the Tester should focus
on" item 5 (which specifically asked for this check, correctly anticipating
it as the most fragile part of the suite).

This does not change any test's pass/fail status — everything that exists
passes — but it is a completeness gap the Reviewer should weigh: AC-3
("free-text validation, all Phase 1 handlers") is not fully satisfied by
this suite for these four fields/schemas.

**Addressed in the reviewer fix-up** (see `.pipeline/changes.md` "Reviewer
fix-up" section): all four gaps now have `FIELD_CASES` entries, including
`reorderSetlistSchema.notes` and `createSongSchema.tags`, which needed a new
`buildInput`/`readValue` override on `FieldCase` since those fields live
inside an array.

## Overall assessment for the Reviewer

- Every command the coder claimed to have run was independently re-run and
  matches exactly (lint clean, typecheck clean, 2535/2535 tests, RLS
  skip-behavior as documented).
- No scope creep: diff is entirely under `tests/` + `.pipeline/`.
- Six of the registry's "escape hatch" entries (the highest-risk part of
  this suite, per the coder's own recommendation) were traced against real
  handler/RPC source and found accurate, not rationalized.
- The AC-2 table-coverage-pin count (19) was independently re-derived from
  the migrations, not just trusted.
- One genuine, non-blocking completeness gap found in the AC-3 schema
  sweep (see above) — four string fields across two schemas plus one
  array-of-strings field are not exercised against the adversarial payload
  corpus. Recommend the Reviewer decide whether this needs a follow-up
  patch to `FIELD_CASES` or can ship as a documented residual gap (similar
  in spirit to the SECURITY FINDINGS already recorded in
  `.pipeline/changes.md`).
- RLS blocks B–E remain unexecuted in any environment so far (no live
  Supabase available here either) — carried forward as an open
  verification item for whoever has DB access before this is fully
  trusted end-to-end.

## Reviewer fix-up follow-up (re-verified)

`.pipeline/review.md` additionally found a **BLOCKING** issue this tester
pass did not catch: the cross-tenant "victim id never leaks" assertion in
`auth-bypass-matrix.test.ts` case 4 could never fail, because
`VICTIM_CHURCH_GROUP_ID`/`VICTIM_USER_ID` were never actually injected into
any request. Fixed by having `makeApiReq` (`tests/support/api-auth.ts`)
unconditionally inject both constants into every request's query string
(and body, when a body object is present) under
`churchGroupId`/`church_group_id`/`userId`/`user_id` keys — see
`.pipeline/changes.md` "Reviewer fix-up" for the full description, including
the one documented exception (`GET /api/availability`'s plain entry).
Combined with the AC-3 gap fix above and the AC-2 coverage-pin
strengthening (migration cross-check), re-ran cold:

- `bun run lint` — PASS (0 errors; 1 pre-existing warning in generated
  `coverage/`, unrelated).
- `bun run typecheck` — PASS, 0 errors.
- `bun run test` — PASS: **112 suites, 2754 tests, 0 failures** (was
  2535 — the new AC-3 FIELD_CASES account for the increase).
- `bun run test:rls` — PASS: 1 suite / 3 tests (coverage pin, block A —
  was 2 tests; the migration cross-check added one), 11 suites / 294 tests
  skipped (no live Supabase env vars, unchanged).
- `git diff origin/main...HEAD --stat` — still confined to `tests/` +
  `.pipeline/`.
