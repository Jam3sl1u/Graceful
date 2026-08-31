# Test Results — Issue #71: In-app notification inbox endpoints

**Verdict: PASS** — all checks green, coder's claims independently verified.

## Automated checks (re-run from this worktree with Bun)

| Check              | Result | Notes                                              |
| ------------------ | ------ | -------------------------------------------------- |
| `bun install`      | OK     | 709 packages                                       |
| `bun run lint`     | PASS   | `eslint .` clean                                   |
| `bun run typecheck`| PASS   | `tsc --noEmit` clean                               |
| `bun run test`     | PASS   | 137 suites, 3064 tests (3050 pre-existing + 14 new)|

The coder claimed "3050 passed"; confirmed 3050 pre-existing pass unchanged,
and the coder's own `notifications-inbox-route.test.ts` (32 tests) passes.

## Independent verification added

New file: `tests/unit/app/api/notifications-inbox-route.tester.test.ts`
(14 tests, all passing). It is a standalone harness — it does not import or
depend on the coder's test file — and targets spec edge cases the coder's
suite under-covered:

- **Spec item 10 (401 on a missing Supabase JWT for *all four* endpoints).**
  The coder tested this for `listNotifications`, `getUnreadNotificationCount`,
  and `markAllNotificationsRead` but NOT for `markNotificationRead`. Added:
  `markNotificationRead` returns 401 `UNAUTHENTICATED` with no Supabase client
  constructed, plus re-checks of the other three. All pass.
- **Spec item 3 (null `link_entity_id` rows visible to non-guest roles).**
  Verified `admin` / `set_leader` / `member` all receive a
  `google_calendar_reauth_required`-style null-link row, no `.in` filter is
  applied, and the guest-scope lookup (`invitations` query) is skipped
  entirely. Also verified a member can PATCH a null-link row read (no false
  404). All pass.
- **Guest scope `.in` filter on `unread-count`.** The coder only tested the
  guest *empty-scope* short-circuit here; added a guest-with-invitations case
  asserting the scoped `link_entity_id` list AND `is_read=false` both reach
  the query. Pass.
- **Failure case: DB error on the PATCH *update* leg -> 500 `INTERNAL`.** The
  coder tested a 500 on the *fetch* leg only. Added: update-leg driver error
  yields 500 with the generic `"Internal error"` message (no `"deadlock
  detected"` leak), and a null update result yields 404. Pass.
- **Pagination boundary.** `pageSize=100` is accepted (range math correct at
  `page=2` -> `{from:100,to:199}`); `page=-1` rejected with 400. Pass.
- **Key spec decision: guest scope uses ALL invitation statuses.** Verified a
  guest whose only invitation is effectively withdrawn still gets a non-empty
  scope containing the invitation id + week id, the `invitation_withdrawn`
  notification is returned, and the `invitations` query filters by `user_id`
  only (no `status` filter). Pass.

## Behavior confirmed against the spec's named edge cases

All 13 edge cases in `spec.md` are now covered by passing tests (coder's suite
+ the additions above):

1. Guest scoping by invitation / week / setlist ids — covered
2. Guest with zero invitations (empty inbox, count 0, updatedCount 0, PATCH 404) — covered
3. Null `link_entity_id` excluded for guests, visible to other roles — covered (added)
4. Already-read PATCH is idempotent (200, no write issued) — covered
5. PATCH 404 (not 403) for missing / other-user / out-of-scope-guest / null-link-guest — covered
6. PATCH non-UUID id -> 400 `VALIDATION_FAILED`, no Supabase client built — covered
7. Invalid pagination (`page=0`, `page=abc`, `pageSize=0`, `pageSize=101`, `page=-1`) -> 400; missing -> defaults — covered
8. Page past the end -> 200 with `[]` and real total — covered
9. `mark-all-read` with nothing unread -> 200 `{updatedCount: 0}` — covered
10. Missing JWT -> 401 on all four — covered (gap on `markNotificationRead` closed)
11. Any Supabase error (including guest-scope lookup, and PATCH update leg) -> 500 generic — covered (update-leg gap closed)
12. `count: null` coerced to 0 — covered
13. Ordering `created_at desc, id desc` — covered (order-call assertions)

## Notes for the reviewer (not defects — judgement calls to sanity-check)

- **Validation-before-auth-token ordering in `listNotifications` /
  `markNotificationRead`:** `requireAuth` (Clerk) runs first, then Zod
  validation (400), then the Supabase `getToken()` 401 check. So an
  authenticated Clerk user with a bad `page` param gets 400 even if their
  Supabase JWT is absent. This matches the spec's written step order and the
  `withdrawInvitation` precedent; flagging only so it is a conscious choice.
- **Guest PATCH scope check is post-fetch in JS, not a DB `.in` filter:** the
  row is fetched with only the `user_id` / `church_group_id` `.eq` filters,
  then the guest scope membership is checked in the handler. Functionally
  equivalent and matches the spec; the row never leaves the handler on a
  scope miss (404). No cross-tenant leak because RLS + the `.eq` filters
  still bound the fetch.
- **`mark-all-read` returns `data.length`, not a true affected-row count:**
  relies on `.select("id")` returning one row per updated row. Correct for
  PostgREST; worth a glance.
