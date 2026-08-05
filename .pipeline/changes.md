# Changes — Issue #72: Guest invitation flow (existing vs. new user)

Implements the spec in `.pipeline/spec.md` in full. `bun run lint`,
`bun run typecheck`, `bun run test` (1084 tests, all passing), and
`bun run check:service-role` all pass.

## New files

- `supabase/migrations/20260805000001_guest_invitation_flow.sql` — three
  `SECURITY DEFINER` functions:
  - `provision_guest_user(p_email, p_name)` — admin/set_leader-only; creates a
    placeholder `users` row (`role='guest'`, synthetic
    `clerk_id = 'pending_guest_' || md5(...)`) for a brand-new guest email.
    Raises `UNAUTHENTICATED` / `FORBIDDEN` / `EMAIL_TAKEN`.
  - `claim_guest_invitation(p_response_token, p_name)` — swaps a signed-in
    Clerk user's real `sub` in for the placeholder's synthetic `clerk_id`.
    Idempotent re-claim, and raises `UNAUTHENTICATED` / `NOT_FOUND` /
    `ALREADY_CLAIMED` / `NOT_CLAIMABLE` / `USER_ALREADY_IN_GROUP`.
  - `CREATE OR REPLACE accept_invitation(...)` — supersedes
    `20260712000001`'s version with one added branch: a `guest`-role invitee
    gets zero `event_attendees` rows inserted (`attendees_added: 0`), since
    that table is the music-roster slot a guest must never occupy. Everything
    else (status flip, notify, audit) is byte-for-byte unchanged.
  - Not run by CI; self-consistent, `CREATE OR REPLACE` throughout.
- `lib/invitations/guest-access.ts` — `guestHasWeekAccess()` +
  `GUEST_ACCESS_STATUSES = ["pending", "accepted"]`. Awaited directly (never
  `.maybeSingle()`), so a re-invited guest with multiple invitation rows for
  the same week doesn't error.
- `app/api/invitations/guest/route.ts`, `app/api/invitations/guest/claim/route.ts`
  — thin route wrappers calling the two new handlers below.
- `app/(public)/guest/[token]/page.tsx` + `guest-claim-form.tsx` — guest
  account-setup screen. Signed-out renders sign-up/sign-in links with
  `redirect_url` back to `/guest/:token`; signed-in renders the claim form,
  which POSTs to `/api/invitations/guest/claim` and links to
  `/invite/:token` on success.
- Tests: `tests/unit/lib/invitations/guest-access.test.ts`,
  `tests/unit/app/api/invitations-guest-route.test.ts`,
  `tests/unit/app/api/invitations-guest-claim-route.test.ts`.

## Modified files

- `schemas/invitations.ts` — added `createGuestInvitationSchema` (email
  normalized to lowercase) and `claimGuestInvitationSchema`.
- `lib/supabase/types.ts` — hand-added `provision_guest_user` and
  `claim_guest_invitation` to `Database["public"]["Functions"]` only (no
  wholesale regeneration).
- `app/api/invitations/handler.ts` — added `createGuestInvitation` and
  `claimGuestInvitation` (+ `GuestInvitationResponse` type and a
  module-private `appUrl()` helper). `createGuestInvitation` branches on
  whether the invited email already belongs to a non-anonymized user in the
  caller's group: existing-user path runs the *unchanged* BR-08/BR-05 checks
  against that `user_id` (role untouched); new-user path calls
  `provision_guest_user` then skips BR-08/BR-05 (a fresh row has no prior
  invitations). On an invitation-insert failure after provisioning a new
  guest, best-effort deletes the orphan `users` row before returning 500.
  Leaves `// TODO(#68): dispatch the guest invitation email...` — never
  calls `sendEmail` (still a stub on this branch per OPEN QUESTION 1).
  `claimGuestInvitation` does not call `requireAuth` (mirrors
  `app/api/church-group/join/route.ts`'s auth preamble) and maps RPC errors
  to 401/404/409/409/409/500.
- `app/api/service-weeks/[id]/member-view/handler.ts` — `requireRole` now
  includes `"guest"`; guests get a `guestHasWeekAccess` check (404, never
  403) right after the week lookup; the team-directory query now also
  selects `role` and filters out `role === "guest"` rows (defense in depth
  for a member later demoted to guest).
- `app/api/service-weeks/[id]/handler.ts` and
  `app/api/service-weeks/[id]/setlist/handler.ts` — replaced the inline
  `.maybeSingle()` guest-invitation check with `guestHasWeekAccess`, fixing
  the latent bug where a re-invited guest with 2+ invitation rows for the
  same week would 500 instead of 200/404.
- `app/api/events/handler.ts` — for `ctx.role === "guest"` only, added
  `.in("status", GUEST_ACCESS_STATUSES)` to the existing per-caller
  invitations query (member/set_leader scoping is unchanged: any status
  still counts for them).
- `app/(app)/week/[id]/week-view.tsx` + `.module.css` — `DirectoryMember`
  gained `role`; the Roster grid now excludes guests; a new "Guests" section
  lists guest members with a live invitation for the week (status badge via
  `getGuestStatusLabel`) and an "Invite a guest" form (email + optional role
  note) that POSTs to `/api/invitations/guest`; on a new-user response the
  returned `accountSetupUrl` is shown as selectable text.
- `middleware.ts` — added `"/guest(.*)"` to `isPublicRoute` (next to
  `"/join(.*)"`); `/api/invitations/guest` and
  `/api/invitations/guest/claim` are untouched and remain protected (path
  doesn't match the new pattern).
- Existing tests updated for the `guestHasWeekAccess` query-shape change:
  `tests/unit/app/api/service-weeks-id-route.test.ts` and
  `service-weeks-setlist-route.test.ts` (invitations fixture is now an array
  + chain gained `.in()`/`.limit()`), and
  `tests/unit/app/api/service-weeks-member-view-route.test.ts` (users rows
  gained `role`; replaced the old "403 for guest" test with a `guest role`
  describe block covering accepted→200, denied-only→404, no-invitation→404,
  access-check DB error→500, and guest-filtered-out-of-team).
- `.pipeline/spec.md` — the Planning stage's spec for this run (was
  previously issue #66's spec still on disk, uncommitted before this run
  started); included in this commit since it's the git-tracked handoff
  artifact for this run.

## Where the Tester should focus

- The three new/changed RPCs in the migration file are **not exercised by
  CI** (per spec, "not executed by CI") — the Jest suite mocks
  `supabase.rpc(...)` at the boundary, so RPC *behavior* (SQL logic) is only
  verified by reading the migration, not by a passing test run. Worth a
  careful read of `claim_guest_invitation`'s ordering (lock → idempotent
  check → anonymized check → already-claimed check → claimability check →
  already-in-group check → update → audit) against the spec's numbered
  steps.
- `createGuestInvitation`'s existing-vs-new-user branch and the orphan
  cleanup path (delete-on-insert-failure) are the most intricate parts of
  the handler — see the dedicated tests in
  `tests/unit/app/api/invitations-guest-route.test.ts`.
- The `guestHasWeekAccess` semantics (`pending`/`accepted` grant access;
  everything else 404s) are shared across four call sites — worth
  double-checking `app/api/events/handler.ts`'s query-builder branch (typed
  as a mutable `let` reassigned only for guests) didn't regress
  member/set_leader scoping.
- UI changes in `week-view.tsx` have no new dedicated tests (not required by
  spec) but the existing `week-view.test.tsx` / `week-view-tester-supplement.test.tsx`
  suites still pass unmodified — worth a manual sanity check of the new
  "Guests" section and invite-a-guest form if the Tester wants UI coverage
  beyond what's already there.
