# Review — Issue #71: In-app notification inbox endpoints

VERDICT: SHIP

Reviewed: `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`,
`git diff main...HEAD`, the untracked tester supplement, plus the surrounding
code the diff depends on (RLS policies, the four notification producers, the
`invitations` DDL, `middleware.ts` rate-limit tiers, and the `audit-log` /
`preferences` handlers the spec said to copy).

## Independently re-run in this worktree

| Check | Result |
| --- | --- |
| `bun run lint` | clean |
| `bun run typecheck` | clean |
| `bun run test` | 137 suites / 3064 tests, all pass |
| inbox suites only | 46 tests pass (32 coder + 14 tester) |

## Does the code match the spec?

Yes, item by item. All four ACs from the issue are implemented, and every one
of the spec's 13 named edge cases is present in the code (not just asserted in
a test): guest `.in` scoping, guest empty-scope short-circuit on
list/unread-count/mark-all-read, null `link_entity_id` excluded for guests,
idempotent already-read PATCH, uniform 404 (never 403) for missing /
other-user / out-of-scope, 400 on a non-UUID id, pagination validation with
`page=1,pageSize=20` defaults, `created_at desc, id desc` tiebreak,
`count ?? 0`, 401 on a missing Supabase JWT on all four handlers, and a
generic `"Internal error"` for every driver error including the guest-scope
lookup. Scope discipline is good: no migration, no `lib/supabase/types.ts`
edit, no `preferences/*` change, no type filter, no unrelated refactors.

## Claims I verified rather than trusted

- **The "all invitation statuses" decision is actually necessary.** Both
  withdraw paths (`app/api/invitations/handler.ts:822` and
  `app/api/conflicts/handler.ts:247`) set `status = 'withdrawn'` and then
  insert the notification, and neither deletes the invitation row. Filtering
  by `GUEST_ACCESS_STATUSES` would have made the `invitation_withdrawn`
  notification invisible to the guest it was written for. The code is right
  and the comment explains why.
- **The guest scope covers every notification a guest can actually receive.**
  The only four producers write `link_entity_type` of `"service_week"`
  (id = week id), `"invitation"` (x2, id = invitation id) and `"setlist"`
  (id = setlist id) — all three families are in the scope list. No producer
  writes a `"conflict"` link (the spec's list was slightly stale there, but
  the code is not affected).
- **RLS lets the guest-scope helper actually read what it queries.**
  `invitations_select_own` covers the invitations query; the
  `setlist_released` notification is only written on publish, and
  `setlists_select_published_members` lets a guest read published setlists, so
  the setlist ids do come back. No service-role escalation was introduced.
- **The DB permits the writes.** `notifications_update_own` has both USING and
  WITH CHECK on `user_id = auth_user_id()`, so PATCH and mark-all-read are not
  silent no-ops under RLS.
- **`service_week_id` is `not null`** in the invitations DDL, so the
  `weekIds`/`.in("service_week_id", weekIds)` path cannot smuggle a `null`.
- **The endpoints are auth-protected and rate-limited for free**: they are not
  in `isPublicRoute`, and `resolveTier` falls through to `read`/`write` for
  any `/api/*` path, so the spec's "no rate limiting" scope cut leaves no gap.
- **Tests are meaningful, not superficial.** They assert the actual filter
  arguments reaching the fake client (`calls.in`, `calls.eq`, `calls.order`,
  `calls.range`, `calls.update`), not merely status codes, and they assert
  negative facts too (`calls.in` empty for non-guests, `from` never touching
  `invitations` for non-guests, no Supabase client constructed on the 401/400
  paths). The tester's supplement is genuinely independent (own harness) and
  closed two real gaps: the missing `markNotificationRead` 401 case and the
  500 on the PATCH *update* leg.

## Findings (none blocking)

1. **Uncommitted work — must be committed before the PR.**
   `tests/unit/app/api/notifications-inbox-route.tester.test.ts` is untracked
   and `.pipeline/test-results.md` is modified but uncommitted. The single
   commit `41fa7dc` contains only the coder's output. This matches the #70
   pattern ("Add tester supplement test and finalize pipeline artifacts"), so
   it is a shipping step, not a defect — but if it is skipped, 14 of the 46
   tests and the test report never reach the PR.
2. **Route wrappers are untested (repo-wide convention).** Nothing imports
   `app/api/notifications/[id]/read/route.ts`, so the
   `await params` -> `markNotificationRead(req, id)` wiring is only covered by
   `tsc`. Consistent with every other route in this repo (including
   `preferences`), so not a change to make here.
3. **`.in("link_entity_id", ids)` is unbounded for guests.** A guest with many
   invitations across many weeks produces a long PostgREST URL filter. At this
   product's scale (a church group's guests) this is a non-issue; worth
   remembering if guest invitation volume ever grows.
4. **Guests can never see or clear a null-`link_entity_id` notification.**
   Intentional per spec item 3, and self-consistent (list, unread-count and
   mark-all-read all apply the same filter, so no stuck badge). But any future
   notification type written with a null link will be silently invisible to
   guests — worth a line in the #73 UI issue rather than a change here.
5. **Page-past-the-end is proven only against the mock.** Real PostgREST can
   answer an out-of-range `Range` with 416 depending on version/config. The
   existing `audit-log` handler has exactly the same shape, so this is a
   pre-existing repo-wide question, not a regression introduced here.
6. **Minor perf nit:** for a guest, `markNotificationRead` resolves the scope
   (up to 2 extra queries) before it knows the notification even exists. Two
   wasted round-trips on a 404. Not worth restructuring.

None of the above changes behavior in a way that would make a user-visible
result wrong. Ship it, after committing finding 1.
