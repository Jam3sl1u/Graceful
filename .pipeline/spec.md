# Spec — Issue #82: [Sprint 4] Full E2E regression pass across all Phase 1 critical paths

## OPEN QUESTION (blocking — pipeline stops here until a human answers)

**OQ1 — Extra staging Clerk personas are required, and provisioning them is a human action.**

Two of this issue's acceptance criteria cannot be executed with the current
E2E fixture:

- "full admin week-setup flow (**create group** → invite member → **member joins** → …)"
  `PUT /api/church-group` (`app/api/church-group/route.ts`) and
  `POST /api/church-group/join` (`app/api/church-group/join/route.ts`) both
  409 `USER_ALREADY_IN_GROUP` for any Clerk identity that already has a
  `users` row. The only two provisioned staging Clerk personas
  (`E2E_ADMIN_EMAIL`, `E2E_MEMBER_EMAIL`) are permanently bound to the stable
  fixture group (`tests/e2e/support/fixtures.ts` — `users.clerk_id` is UNIQUE,
  which is exactly why that fixture is stable rather than per-test).
- "guest invitation flow end to end (#72) — **new-user path**"
  `claim_guest_invitation` likewise requires a signed-in Clerk identity with
  no `users` row.

So the flow needs **two additional, disposable staging Clerk test-mode users**
whose `users` rows every test deletes on the way in and on the way out:

- `E2E_SETUP_ADMIN_EMAIL` — creates a throwaway church group in the week-setup test.
- `E2E_GUEST_EMAIL` — joins that group in the week-setup test, and claims the
  guest invitation in the guest new-user test.

**Question for the human:** provision those two Clerk test-mode users in the
staging Clerk instance and add `E2E_SETUP_ADMIN_EMAIL` / `E2E_GUEST_EMAIL` as
GitHub Actions secrets (Option A — this spec is written for Option A and is
otherwise complete), **or** accept a degraded pass where the create-group /
join / guest-claim steps are simulated with the service-role client and are
therefore not end-to-end (Option B — not recommended; this is the "are we
actually done" gate).

Note: under Option A the two new specs still self-skip when the new secrets
are absent (same `test.skip(...)` pattern as the rest of the suite), so the
repo stays green locally and in a secretless CI — but AC "All tests pass
against staging in a single CI run" is only genuinely met once the secrets
exist.

**Do not proceed past this point without a human answer.**

---

## Current state (verified in this worktree — do not re-assume)

- `tests/e2e/` already contains #52's suite (`invitation-accept`,
  `invitation-deny`, `invitation-reminder`, `conflict-detection`) and #66's
  suite (`setlist-publish`, `setlist-duplicate-song`, `calendar-sync`), plus
  `health.spec.ts`.
- `playwright.config.ts` has `testDir: "./tests/e2e"`, `fullyParallel: false`,
  `workers: 1`, and targets `STAGING_APP_URL` when set. The CI `e2e` job
  (`.github/workflows/ci.yml`) runs `bun run test:e2e` once against staging.
  **AC #1 ("re-run #52's and #66's suites together against the same staging
  deploy") is therefore already satisfied by the existing config — no change
  needed there beyond documentation.** Do not restructure the runner.
- `app/(app)/notifications/page.tsx` is still a stub (`Notification Inbox —
  coming soon`). The implemented inbox is the API from #71:
  `GET /api/notifications`, `GET /api/notifications/unread-count`,
  `PATCH /api/notifications/:id/read`, `POST /api/notifications/mark-all-read`
  (`app/api/notifications/handler.ts`).
- The Week View's Events card is a TODO stub (`app/(app)/week/[id]/week-view.tsx`
  ~line 606: `{/* TODO(#59): wire to GET/POST /api/events */}`) — there is no
  event-creation UI. `POST /api/events` exists (`app/api/events/handler.ts`,
  body schema `schemas/events.ts`).
- Roster "Pending" badge is real UI: `getRosterStatus` in `week-view.tsx`
  renders a `Pending` badge for a pending invitation, and `+ Invite` sends one.
- Guest invite UI is real: the "Invite a guest" form in `week-view.tsx` posts
  to `POST /api/invitations/guest` (`app/api/invitations/handler.ts`
  `createGuestInvitation`), which returns `{ isNewUser, guestUserId,
  inviteUrl, accountSetupUrl }`; new users land on `/guest/:token`
  (`app/(public)/guest/[token]/guest-claim-form.tsx`).
- `church_groups` deletion cascades to `users`, `service_weeks`,
  `invitations`, `notifications`, `songs`, etc. (every `church_group_id` FK in
  `supabase/migrations/*` is `on delete cascade`).
- Jest ignores `tests/e2e/` (`jest.config.js` `testPathIgnorePatterns`), so
  new specs do not affect `bun run test`.

## Decisions (not open questions — implement as written)

- **D1 — "inbox" means the #71 API, not the stub page.** Assert the
  notification inbox through `GET /api/notifications` /
  `PATCH /api/notifications/:id/read` issued from the **authenticated browser
  session** (`page.request`, which carries the Clerk session and therefore
  exercises real authorization), not through the service-role client and not
  through `/notifications`. Use the service-role client only to seed/tear down
  and to cross-check the row.
- **D2 — "admin creates events" goes through `POST /api/events`** from the
  admin's authenticated `page.request`, because no event-creation UI exists
  (#59). Every other step of the week-setup flow must go through the UI where
  UI exists (join form, setlist builder, `+ Invite` button, roster badge).
- **D3 — no product code changes.** This issue is a test/regression gate only.
  Do not implement the notifications page, the events UI, or anything else
  found missing above; if a flow cannot be exercised, that is a finding, not a
  fix.

## Files to create

### 1. `tests/e2e/week-setup-flow.spec.ts`

One `test.describe("admin week setup flow")` with **one continuous test**
(AC explicitly says "as one continuous test").

Gate: `test.skip(!e2eDisposablePersonasEnabled, "requires staging E2E secrets + disposable personas — see tests/e2e/support/env.ts")`.

Sequence (all inside `try/finally`, copy the structure of
`tests/e2e/setlist-publish.spec.ts` — separate `browser.newContext()` per
persona, failure-tolerant cleanup, DB teardown last):

1. `await resetDisposablePersona(svc, <setup admin email>)` and the same for
   the guest/joiner email (defensive: a previous failed run may have left them
   bound to a group).
2. Setup-admin context → `goto("/")` → `signInAsEmail(page, requireEnv("E2E_SETUP_ADMIN_EMAIL"))`.
3. `PUT /api/church-group` via `adminPage.request.put("/api/church-group", { data: { name, timezone } })`
   (body per `schemas/church-group.ts` — read it, do not guess). Expect 201.
   Capture the new `churchGroupId` from the response; read the group's
   `invite_code` from the DB with the service-role client (do not assume the
   RPC's response field names).
4. Joiner context → `goto("/")` → `signInAsEmail(page, requireEnv("E2E_GUEST_EMAIL"))`
   → `goto("/join/<inviteCode>")` → click `Join group` → expect heading
   `You're in!` (`app/(public)/join/[code]/join-form.tsx`).
5. Admin creates a service week: `POST /api/service-weeks` (body per
   `schemas/service-weeks.ts`), `serviceDate = futureDateString(10)`. Expect
   201, capture id.
6. Admin builds the setlist: `POST /api/service-weeks/<id>/setlist` → capture
   `setlist.id`; seed one song in the **new** group with
   `seedSong(svc, newChurchGroupId, …)` — note `seedSong` currently hardcodes
   `created_by: FIXTURE.adminUserId`, which is wrong for a different group, so
   add an optional `createdBy` option to `seedSong` and pass the new admin's
   `users.id`. Then `goto("/setlists/<setlistId>")`, fill `Search songs`, click
   `Add`, expect `1 song` (copy `setlist-publish.spec.ts` exactly).
7. Admin creates events: `POST /api/events` with `type: "rehearsal"` and
   `startTime`/`endTime` **within 72h of the service date anchored at
   00:00:00Z** (BR-10, `validateEventTiming` in `schemas/events.ts`) — expect
   201. Then a second event with `type: "service"`. Cross-check both rows
   exist for the week via the service client.
8. Admin sends the invitation through the UI: `goto("/week/<serviceWeekId>")`,
   find the joined member's roster slot, click `+ Invite`.
9. Assert the roster shows `Pending` for that member (UI), and that a
   `pending` `invitations` row exists for the joiner's `users.id` (DB).
10. `finally`: close contexts (each in its own try/catch, log on failure),
    then `teardownFixtures(svc, { churchGroupIds: [newChurchGroupId] })`
    (cascade removes everything below it) and `resetDisposablePersona` for
    both personas.

### 2. `tests/e2e/notification-inbox.spec.ts`

`test.describe("notification inbox")`, gate on `e2eAuthEnabled` only (uses the
stable fixture — must run even without the OQ1 secrets).

Test: "an action fires a notification, it appears in the recipient's inbox, and marking read works"

1. Seed: `seedServiceWeek(svc, FIXTURE.churchGroupId, futureDateString(11))`,
   `seedInvitation(... userId: FIXTURE.memberUserId, invitedBy: FIXTURE.adminUserId, status: "pending")`.
2. Admin context signed in as `admin`: `DELETE /api/invitations/<id>` (the
   withdraw path in `app/api/invitations/handler.ts` inserts an
   `invitation_withdrawn` notification for the member). Expect `ok()`.
3. Member context signed in as `member`:
   - `GET /api/notifications?page=1&pageSize=20` → the item with
     `linkEntityId === invitationId` is present, `type === "invitation_withdrawn"`,
     `title === "Invitation withdrawn"`, `isRead === false`.
   - `GET /api/notifications/unread-count` → `unreadCount >= 1`.
   - `PATCH /api/notifications/<notificationId>/read` → 200,
     `data.notification.isRead === true`.
   - Re-`GET /api/notifications` → same item now `isRead: true`.
   - Idempotency edge case: `PATCH` the same id again → still 200, still
     `isRead: true`, no error.
   - **Failure case (required):** seed a notification owned by
     `FIXTURE.adminUserId` (insert directly via the service client with a
     distinct `link_entity_id`), then `PATCH` it from the **member** session →
     expect `status() === 404` (never 403, never 200). Tear that row down.
4. `finally`: `teardownFixtures(svc, { serviceWeekId, invitationId, notificationLinkEntityIds: [invitationId, <adminNotificationLinkEntityId>] })`.

### 3. `tests/e2e/guest-invitation.spec.ts`

`test.describe("guest invitation")` with two tests.

**Test A — existing-user path** (gate: `e2eAuthEnabled` only):

1. Seed a service week in `FIXTURE.churchGroupId`.
2. Admin session: `POST /api/invitations/guest` with
   `{ serviceWeekId, email: <E2E_MEMBER_EMAIL> }` → 201.
3. Assert `data.isNewUser === false`, `data.guestUserId === FIXTURE.memberUserId`,
   `data.accountSetupUrl === null`, `data.inviteUrl` ends with
   `/invite/<responseToken>`.
4. Assert via the service client that `users.role` for `FIXTURE.memberUserId`
   is still `"member"` (PRD Flow 6 step 2a — no silent privilege change) and
   that the invitation row is `pending`.
5. Member accepts via `/invite/<token>` UI (copy `invitation-accept.spec.ts`)
   → invitation `accepted`.
6. `finally`: `teardownFixtures(svc, { serviceWeekId, invitationId })`.

**Test B — new-user path** (gate: `e2eDisposablePersonasEnabled`):

1. `resetDisposablePersona(svc, requireEnv("E2E_GUEST_EMAIL"))`.
2. Seed a service week in `FIXTURE.churchGroupId`.
3. Admin session, through the **Week View UI**: `goto("/week/<id>")`, fill the
   "Invite a guest" email field, submit `Invite guest`, and assert the
   account-setup link paragraph appears (the `guestAccountSetupUrl` block in
   `week-view.tsx`). Read the created invitation + placeholder user from the
   DB (service client) to get the `response_token` and `guestUserId`; assert
   the placeholder's `clerk_id` has the `pending_guest_` prefix (confirm the
   exact prefix in `supabase/migrations/*` `provision_guest_user` before
   asserting) and `role === "guest"`.
4. Guest context: `goto("/")` → `signInAsEmail(page, requireEnv("E2E_GUEST_EMAIL"))`
   → `goto("/guest/<responseToken>")` → click
   `Finish setting up your account` → expect heading `You're all set!`.
5. Assert via the service client that the placeholder row's `clerk_id` is now
   the guest persona's real Clerk id (`resolveClerkUserId(...)`) and
   `church_group_id === FIXTURE.churchGroupId`.
6. Guest clicks `View your invitation` (or navigates to `/invite/<token>`) and
   accepts → invitation `accepted`.
7. **Failure/edge case (required):** re-`POST /api/invitations/guest/claim`
   with the same token from the guest session → expect a non-2xx with the
   documented conflict/idempotent behavior in `claimGuestInvitation`
   (`ALREADY_CLAIMED` → 409, or `already_claimed: true` on 201 — read the
   `claim_guest_invitation` migration and assert whichever it actually does;
   do not assert both).
8. `finally`: close contexts, `teardownFixtures(svc, { serviceWeekId, invitationId, userIds: [guestUserId] })`,
   then `resetDisposablePersona`.

## Files to modify

### `tests/e2e/support/env.ts`

Add, in the existing style (keep the header comment accurate — extend the
required-vars doc block):

```ts
export const DISPOSABLE_PERSONA_VARS = ["E2E_SETUP_ADMIN_EMAIL", "E2E_GUEST_EMAIL"] as const;

/** True only when the base E2E secrets AND both disposable-persona emails are set. */
export const e2eDisposablePersonasEnabled: boolean = checkEnv(DISPOSABLE_PERSONA_VARS);
```

### `tests/e2e/support/auth.ts`

Add an email-keyed sign-in, keeping `signInAs` as-is (delegating to it):

```ts
export async function signInAsEmail(page: Page, emailAddress: string): Promise<void>;
```

### `tests/e2e/support/fixtures.ts`

1. `seedSong`: add `createdBy?: string` to the options object, defaulting to
   `FIXTURE.adminUserId` (existing callers unchanged).
2. New helper:

```ts
/**
 * Clears a disposable Clerk persona's app-side state so it can create/join a
 * group again on the next run. Deletes any church group the persona OWNS
 * (cascades its users row) and otherwise deletes just the persona's users row.
 * Hard guard: throws if the resolved group is FIXTURE.churchGroupId — never
 * touch the stable fixture.
 */
export async function resetDisposablePersona(svc: SupabaseClient, email: string): Promise<void>;
```

Implementation notes: `resolveClerkUserId(email)` → select
`id, church_group_id, role` from `users` where `clerk_id = <that id>`; if no
row, return. If `church_group_id === FIXTURE.churchGroupId`, throw (never
delete fixture members; a persona landing there means the test used the wrong
email). Otherwise delete the `church_groups` row when `role === "admin"`
(cascade), else delete the `users` row.

3. `TeardownIds`: add `churchGroupIds?: string[]`, deleted **last** in
   `teardownFixtures`, with the same `FIXTURE.churchGroupId` guard (throw if
   present).

### `.github/workflows/ci.yml`

In the `e2e` job's `env:` block only, add:

```yaml
      E2E_SETUP_ADMIN_EMAIL: ${{ secrets.E2E_SETUP_ADMIN_EMAIL }}
      E2E_GUEST_EMAIL: ${{ secrets.E2E_GUEST_EMAIL }}
```

Update the job's leading comment to mention the Phase 1 regression specs
(week-setup, notification-inbox, guest-invitation) and that the two new
persona secrets are optional (those specs skip when absent). Do not change
the `check-secrets` gate.

### `documentation/staging-environment.md`

In §7: add `E2E_SETUP_ADMIN_EMAIL` and `E2E_GUEST_EMAIL` to the secrets table
(marked optional, "the #82 week-setup and guest new-user specs skip when
absent"), extend item 1 to describe the two disposable personas and the
reset-on-both-ends contract, and add a short "§7.2 Phase 1 regression pass
(issue #82)" subsection stating that the whole suite — #52, #66, and the #82
additions — runs in the single `bun run test:e2e` CI invocation against one
staging deploy, and that the stale note at §7's end ("`GET /api/notifications`
is an unimplemented 501 stub") is now obsolete because #71 shipped it.

## Edge cases the implementation must handle

- **Disposable personas are reset before AND after every test that uses them.**
  A crashed prior run must not poison the next one.
- **Never delete `FIXTURE.churchGroupId`, `FIXTURE.adminUserId`, or
  `FIXTURE.memberUserId`** — guard with a thrown error, not a silent skip.
- **BR-10**: event times must be within 72h of `serviceDate` anchored at
  `T00:00:00.000Z`, and `endTime > startTime`, or `POST /api/events` returns
  422.
- **Serial execution only.** New specs share the stable fixture; they must not
  rely on parallelism and must not reintroduce it. `workers: 1` stays.
- **`seedSong` in a non-fixture group** needs a `created_by` that exists in
  that group (FK) — hence the new `createdBy` option.
- **Notification assertions must be entity-scoped** (`link_entity_id` +
  `user_id` + `type`), never "some unread notification exists" — the staging
  DB accumulates rows across runs.
- **`PATCH /api/notifications/:id/read` on another user's row must be 404**,
  not 403 and not 200 (`markNotificationRead` deliberately does not leak
  existence).
- **Guest existing-user path must not change the existing user's role.**
- **Idempotency**: marking an already-read notification read is 200; re-claiming
  a guest invitation behaves as the RPC defines (assert the real behavior).
- **Every test cleans up in `finally`**, with context-close failures caught and
  logged so DB teardown still runs (`setlist-publish.spec.ts` pattern).

## Patterns to copy (by file)

- Overall spec shape, multi-persona contexts, failure-tolerant cleanup:
  `tests/e2e/setlist-publish.spec.ts`.
- Token/public-page flow + entity-scoped notification assertions:
  `tests/e2e/invitation-accept.spec.ts`.
- Secret gating / skip-not-fail: `tests/e2e/support/env.ts` +
  `test.skip(!e2eAuthEnabled, …)` at the top of every describe.
- Seed/teardown helpers and the stable-vs-per-test fixture rules:
  `tests/e2e/support/fixtures.ts` (read its header comment before editing).

## Verification before finishing

- `bun run lint`
- `bun run typecheck`
- `bun run test` (Jest must be unaffected — `tests/e2e/` is ignored)
- `bunx playwright test --list` (proves the new specs parse/compile and are
  discovered without staging secrets)

Do not run `bun run test:e2e` locally without staging secrets — every new spec
will skip, which proves nothing.

## Out of scope

- Implementing `/notifications`, the Events UI (#59), or any other product
  code (D3).
- Phase 2+ flows (chat, document library).
- Changing `playwright.config.ts` runner semantics or the `check-secrets` CI gate.
