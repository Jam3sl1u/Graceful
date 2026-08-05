# Test Results — Issue #72: Guest invitation flow (existing vs. new user)

## Verdict: PASS

All verification commands pass, both as originally claimed by the Coding
stage and after re-running them independently, plus after adding two new
supplemental test files (below) that close gaps left by the coder's own
mocks.

```
bun run lint             -> clean (0 errors, 0 warnings)
bun run typecheck         -> clean
bun run test              -> 87 suites, 1091 tests, all passing
bun run check:service-role -> OK: no service-role key references outside comments
```

(1084 tests / 85 suites were the coder's; +7 tests / +2 suites are new,
added below.)

## What I independently verified

- **Migration SQL** (`supabase/migrations/20260805000001_guest_invitation_flow.sql`,
  not run by CI): read in full and diffed `accept_invitation`'s body against
  the prior `20260712000001` version — confirmed it is byte-for-byte
  identical except the added guest branch (declares `v_invitee_role`, looks
  up the invitee's role, and skips the `event_attendees` insert /
  `GET DIAGNOSTICS` when `role = 'guest'`, else the original insert runs
  unchanged). Confirmed `claim_guest_invitation`'s step order exactly matches
  the spec's numbered list: auth -> resolve by token -> lock row -> idempotent
  re-claim -> anonymized check -> already-claimed check (`pending_guest_`
  prefix / role) -> claimability check (`pending`/`accepted`) ->
  already-in-group check -> update (never touches `email`) -> direct
  `audit_logs` insert -> return. Confirmed `provision_guest_user`'s caller
  check (UNAUTHENTICATED / FORBIDDEN), global `EMAIL_TAKEN` check, and the
  `pending_guest_<32 hex>` clerk_id construction/length (46 chars, fits
  `varchar(50)`).
- **Handler code** (`app/api/invitations/handler.ts`,
  `app/api/service-weeks/[id]/member-view/handler.ts`,
  `app/api/service-weeks/[id]/handler.ts`,
  `app/api/service-weeks/[id]/setlist/handler.ts`, `app/api/events/handler.ts`,
  `lib/invitations/guest-access.ts`, `schemas/invitations.ts`,
  `lib/supabase/types.ts`, `middleware.ts`,
  `app/(app)/week/[id]/week-view.tsx`, `app/(public)/guest/[token]/*`): read
  every changed file and confirmed each matches its corresponding spec
  section line-for-line (existing-vs-new-user branch, BR-08/BR-05 reuse,
  orphan-cleanup-on-insert-failure, `guestHasWeekAccess` semantics and its
  four call sites, the guest-filtered `team` query, the `"/guest(.*)"`
  middleware addition — confirmed it does NOT also match
  `/api/invitations/guest` or `/api/invitations/guest/claim`, since
  `createRouteMatcher` anchors from the path start and those paths begin with
  `/api`, not `/guest`).
- Confirmed the existing coder-written test suites
  (`tests/unit/lib/invitations/guest-access.test.ts`,
  `tests/unit/app/api/invitations-guest-route.test.ts`,
  `tests/unit/app/api/invitations-guest-claim-route.test.ts`, and the guest
  additions to `tests/unit/app/api/service-weeks-member-view-route.test.ts`)
  cover every case the spec's "Tests the coder must add" section names.

## Gap found and closed: two new supplemental test files

The coder's own fixtures for `createGuestInvitation` and `listEvents` use
pass-through `.eq()`/`.is()`/`.in()` mocks that ignore their arguments and
always return the same canned fixture regardless of what was actually
queried. That means a regression in the *query shape itself* — e.g. the
existing-user lookup forgetting to filter by `church_group_id` or
`anonymized_at`, or the guest-only `.in("status", GUEST_ACCESS_STATUSES)`
filter in `app/api/events/handler.ts` silently being dropped — would not have
been caught by the existing suite (the fixture would still be returned
either way). I wrote two new suites that record the actual arguments passed
and assert on them, following this repo's established
`*-tester-supplement.test.ts` pattern:

- `tests/unit/app/api/invitations-guest-route-tester-supplement.test.ts`
  - existing-user lookup is scoped by `church_group_id`, the invited
    (lowercased) email, and excludes anonymized users.
  - an email belonging to a user in a *different* group is invisible to that
    lookup and correctly falls through to the new-user/provisioning branch
    (edge case 2 from spec.md).
  - `EMAIL_TAKEN` from `provision_guest_user` maps to 409 CONFLICT with an
    error message that never mentions "group" (no cross-tenant leak).
- `tests/unit/app/api/events-route-guest-scoping-tester-supplement.test.ts`
  - `member`/`set_leader` callers do NOT get a `.in("status", ...)` filter
    (any invitation status still counts for them, unchanged).
  - a `guest` caller's invitations query is filtered with exactly
    `.in("status", GUEST_ACCESS_STATUSES)`.
  - (failure/edge case) a guest whose only invitation for a week is `denied`
    sees zero events for that week, and the `events` table is never even
    queried once the guest has no accessible weeks.

**I verified these new tests actually catch regressions**, not just that
they pass: I temporarily reverted the `.is("anonymized_at", null)` +
`church_group_id` filter in the existing-user lookup, and separately removed
the guest-only `.in("status", GUEST_ACCESS_STATUSES)` branch in
`app/api/events/handler.ts`, and confirmed each corresponding new test failed
as expected. Both files were then restored to their original (coder-shipped)
content — `git status` / `git diff --stat` confirm zero changes to any
source file, only the two new test files are new/untracked.

## Manual/logical review of UI (no dedicated tests required by spec)

- `app/(app)/week/[id]/week-view.tsx`: `rosterMembers`/`guestEntries` split
  is derived correctly from `members.filter(role)`; `guestEntries` further
  filters to only guests with a `getCurrentInvitation` match, so an
  uninvited guest member never shows a card. `handleInviteGuest` posts the
  correct body shape and surfaces `accountSetupUrl` only when
  `isNewUser === true`, matching spec item 12.
- `app/(public)/guest/[token]/page.tsx` + `guest-claim-form.tsx`: signed-out
  branch renders sign-up/sign-in links with a correctly `encodeURIComponent`-ed
  `redirect_url` back to `/guest/:token`; signed-in renders the claim form;
  the form POSTs the exact body shape `claimGuestInvitationSchema` expects
  and links to `/invite/:token` on success.

## Failure case coverage confirmed

At least one genuine failure/negative case is present and passing in every
touched area: 401/403/400/404/409/500 mappings in both guest route test
files, `dbError: true` in `guest-access.test.ts`, guest-denied-only -> 404 in
the member-view tests, and the two new regression-catching failure
assertions above.

## Recommendation

No blocking issues found. Ready for Review stage.
