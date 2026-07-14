# Test Results — Issue #48: Build Week View screen (Admin / Set Leader)

## Verdict: PASS

This overwrites the stale `test-results.md` for issue #51 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Commands re-run independently in this worktree

- `bun run typecheck` — clean, no errors.
- `bun run lint` — clean, no errors/warnings.
- `bun run test` (Jest, full suite, including two new tester-supplement files
  added below) — **44 test suites, 503 tests, all passing.**
- Before adding any new tests: ran the full suite once as-is (coder's diff
  only) — **42 suites / 496 tests**, matching `changes.md`'s claimed count
  exactly.

## Independent verification performed

1. **Diff scope matches `changes.md`**: `git diff --stat 4dd31d6 27be00c` (the
   commit range for this issue) touches exactly the 8 files `changes.md`
   lists (`schemas/invitations.ts`, `app/api/invitations/{handler,route}.ts`,
   `app/(app)/week/[id]/{page.tsx,week-view.tsx,week-view.module.css}`, and
   the two new test files) — no scope creep, no unrelated refactor.

2. **Response-token leak (the spec's single most important backend
   correctness point)**: read `app/api/invitations/handler.ts` directly.
   `listInvitations` selects an explicit column string (`"id, service_week_id,
   user_id, role_note, status, response_deadline, created_at"`) — never
   `select("*")` — and `WeekInvitation`/`toWeekInvitation` never touch
   `response_token`/`denial_reason`. Confirmed the existing
   `invitations-list-route.test.ts` happy-path test asserts both the absence
   of the `responseToken` key and that the executed `select(...)` string
   isn't `"*"` and doesn't mention `response_token`.

3. **Tenant isolation on the read path (gap the coder's own test left
   open)**: the coder's `makeChain`/`makeSupabaseClient` helpers in
   `invitations-list-route.test.ts` never record what `.eq(...)` is actually
   called with — they only assert the final resolved `{ data, error }`. A
   regression that silently dropped the `.eq("church_group_id",
   ctx.churchGroupId)` filter (cross-tenant leak) would have stayed green.
   Added `tests/unit/app/api/invitations-list-route-tester-supplement.test.ts`
   with a recording chain that captures every `.eq(...)` call's arguments and
   asserts both `service_week_id` and `church_group_id` are filtered on, and
   that an "other" group id is never used. Also added: a `guest`-role 403
   case (the coder's suite only tries `member`), and an exact-column-list
   assertion (not just "isn't `*`") so a regression that also dropped a
   *needed* column (e.g. `status`) would be caught.

4. **Conflict-precedence logic** (`getRosterStatus` in `week-view.tsx`): read
   the implementation — `conflictInvitationIds.has(current.id)` is checked
   before any `status` comparison, matching the spec's precedence table
   exactly. The coder's own test explicitly covers the
   accepted-but-conflicted → "Conflict" (not "Confirmed") case; confirmed by
   running it and by reading the code, not just trusting the test name.

5. **"No invitation, or only withdrawn/expired" → Open (gap the coder's own
   test left open)**: the coder's roster-mapping test only tries a member
   entirely *absent* from the invitations list for the Open case — a member
   whose current invitation is `withdrawn` was never tried, so a regression
   that mapped `withdrawn` to some other label (or threw) wouldn't be caught.
   Added a case to `week-view-tester-supplement.test.tsx` covering exactly
   this: a member whose only invitation has `status: "withdrawn"` renders
   "Open" with a working "+ Invite" button.

6. **Nav-arrow index math on a genuine list edge (gap the coder's own test
   left open)**: the coder's "disabled arrow" behavior is only exercised via
   a *failed* week-list fetch (both arrows degrade together). Added a case
   where the week-list fetch succeeds and the current week is genuinely first
   (newest) in the list — confirms `getNeighborWeekIds`'s index math disables
   only the "next" arrow while "prev" still resolves to the correct
   neighbor, independently of fetch-failure degradation.

7. **403 gating on all four core fetches, not just one (gap the coder's own
   test left open)**: the coder's suite only tries a 403 on
   `/api/church-group/members`. Per the spec, `/api/invitations` and
   `/api/conflicts` are equally core, forbidden-gated fetches. Added two
   cases confirming a 403 on either independently routes to the same
   `"forbidden"` view (a regression that only checked `membersRes.status`
   would have passed the coder's suite while silently rendering a broken
   grid on an invitations/conflicts 403).

8. **Role-gating claim re: the `(app)` layout**: confirmed by reading
   `app/(app)/layout.tsx` — it has an explicit `TODO(Sprint 0 #6)` and does
   **not** enforce role; `middleware.ts` has no `week`-specific gating either.
   This matches `changes.md`'s claim that the client-side 403 handling in
   `week-view.tsx` is the only real gate today, making point 7 above a
   meaningful check rather than a redundant one.

9. **UTC availability-window date math**: read `addDaysUTC`/
   `getAvailabilityWindow` in `week-view.tsx` — uses
   `new Date(\`${dateStr}T00:00:00Z\`)` plus `n * 86_400_000`, matching
   `schemas/availability.ts`'s UTC convention (checked directly). No local-
   timezone off-by-one risk since all arithmetic and formatting
   (`formatShortDate`'s `timeZone: "UTC"`) stay in UTC.

## Failure cases covered

- Backend: 500 on a Supabase query error (`INTERNAL`), 400 on missing/
  non-uuid `serviceWeekId`, 401 with no JWT, 403 for `member` (coder) and
  `guest` (added).
- Frontend: a thrown/rejected `fetch` on the core batch → `"error"` view
  (coder); 403 on `church-group/members` (coder), `invitations` (added),
  `conflicts` (added) → `"forbidden"` view; 404 on the service-week fetch →
  `"not-found"` view (coder).

## Edge cases named in the spec, confirmed covered

- Response-token/denial_reason never leaked (backend).
- Explicit-columns-only select, never `select("*")` (backend, both files).
- Tenant isolation (`church_group_id` filter actually applied — added).
- Role gating on `/api/invitations`, `/api/availability/team`,
  `/api/conflicts` (backend 403s; frontend forbidden-view routing for all
  three core-fetch sources, not just one).
- Multiple invitations per member/week → max-`createdAt` wins (coder's
  conflict-member fixture has a stale `denied` row plus a newer `accepted`
  row).
- Member with no invitation, and member with only a `withdrawn` invitation →
  both read "Open" + "+ Invite" (coder + added).
- Conflict precedence overrides "Confirmed" (coder).
- Cancelled week → `Cancelled` danger badge, not `Draft` (coder).
- Empty roster, empty availability, degraded week-list/availability fetches,
  and a genuine no-neighbor list edge (coder + added) → no crashes.
- UTC date math for the availability window (read/confirmed).
- `{ data }` envelope unwrapped on every fetch (read/confirmed).

## Conclusion

All of the coder's claims in `.pipeline/changes.md` check out under
independent verification: typecheck and lint are clean, the originally-shipped
suite is exactly 42/42 suites and 496/496 tests as claimed, and the diff scope
matches exactly what `changes.md` describes. Two gaps were found in the
coder's own test coverage (tenant-isolation filter arguments were never
asserted on the read endpoint, and three edge cases — withdrawn-only
invitation, genuine list-edge nav arrows, and 403 on the invitations/conflicts
fetches specifically — were untested); both are closed with new,
independently-written tests in
`tests/unit/app/api/invitations-list-route-tester-supplement.test.ts` and
`tests/unit/app/week-view-tester-supplement.test.tsx`. No behavioral defects
were found — every added test passed against the existing implementation on
the first run, meaning these were coverage gaps, not bugs. Full suite is now
44/44 suites, 503/503 tests, green. Ready for review.
