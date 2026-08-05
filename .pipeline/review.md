# Review — Issue #72: Guest invitation flow (existing vs. new user)

VERDICT: NEEDS WORK

Scope of this review: `.pipeline/spec.md`, `.pipeline/changes.md`,
`.pipeline/test-results.md`, `git diff main...HEAD` read in full, plus my own
runs of `bun run lint`, `bun run typecheck`, `bun run test`
(87 suites / 1091 tests, all green) and `bun run check:service-role` (OK).

The design is sound and the implementation tracks the spec closely. Two
things must change before a human sees this as done; two more are judgment
calls a human should make explicitly.

---

## MUST FIX

### 1. Existing-user email lookup is case-sensitive; the RPC guarding it is not
`app/api/invitations/handler.ts:337-345`

```ts
.from("users").select("id")
  .eq("church_group_id", ctx.churchGroupId)
  .eq("email", parsed.email)      // parsed.email is lowercased by the schema
  .is("anonymized_at", null)
```

`users.email` is never normalized on write: `join_church_group`
(`supabase/migrations/20260706000002_church_group_join_rpc.sql:68-69`)
inserts Clerk's `primaryEmailAddress.emailAddress` verbatim, and there is no
lowercase constraint, trigger, or citext on the column. Meanwhile
`provision_guest_user` guards with `lower(email) = lower(p_email)`
(`supabase/migrations/20260805000001_guest_invitation_flow.sql`, step 3) — so
the handler and the migration it was written alongside disagree about
case-sensitivity.

Consequence: for any existing user whose stored email contains an uppercase
character, the group-scoped lookup misses, the code takes the **new-user**
branch, `provision_guest_user` raises `EMAIL_TAKEN`, and the admin gets a
permanent 409 with no way to invite that person as a guest. That silently
defeats spec edge case 1 and AC bullet 2 ("Existing-user path: invitation
created directly with the known user_id"). It fails closed (no data
corruption, no leak), which is why it is NEEDS WORK and not BLOCK.

Fix, in `createGuestInvitation`: make the lookup case-insensitive without
reintroducing LIKE semantics — note that a bare `.ilike("email", parsed.email)`
is *not* a safe drop-in, because `_` and `%` are legal in the local part of an
address and would become wildcards matching a different user's row. Either
escape `%`/`_` before `.ilike`, or normalize `users.email` to lowercase at
write time (`join_church_group` + a one-off data migration) and keep `.eq`.
This is the only `eq("email", …)` in the codebase, so whichever rule is chosen
becomes the precedent — state it in a comment.

Add a test with a mixed-case stored email (e.g. row `Guest@Example.com`,
request `guest@example.com`) asserting `isNewUser === false` and that
`provision_guest_user` is never called.

### 2. The Tester stage's two supplemental suites are not committed
`git status` shows them untracked, so they are absent from
`git diff main...HEAD` and would not reach the PR:

- `tests/unit/app/api/events-route-guest-scoping-tester-supplement.test.ts`
- `tests/unit/app/api/invitations-guest-route-tester-supplement.test.ts`

These are the *only* tests in the change that assert on actual query
arguments (every other fixture is a pass-through mock that returns the same
canned data regardless of what was filtered), so losing them removes the
regression protection the Testing stage specifically added. Commit both,
along with the modified `.pipeline/test-results.md`.

---

## HUMAN DECISION REQUIRED (do not silently ship)

### 3. AC bullet 4's "NO instrument/key UI" is not honoured
Guests are now admitted to `GET /api/service-weeks/:id/member-view`
(`app/api/service-weeks/[id]/member-view/handler.ts:76`), which returns
`setlist.songs[].effectiveKey` and `team[].vocalCapability` /
`team[].instruments`, and `app/(app)/member-week/[id]/member-week-view.tsx:228,272`
renders both. The issue's AC says guests get "NO music roster slot, NO
instrument/key UI"; the roster-slot half is correctly implemented (the
`event_attendees` branch in `accept_invitation` plus the `role !== "guest"`
filter on `team`), the instrument/key half is not.

`.pipeline/spec.md` "Explicitly out of scope" deliberately deferred this, and
the issue's own Out of Scope section ("guest-specific UI polish beyond reusing
#49/#65's existing screens with scoped data") can be read either way. Cheapest
honest fix is ~5 lines in the member-view handler: when `ctx.role === "guest"`,
null out `effectiveKey` and emit `team` entries without
`instruments`/`vocalCapability`. Otherwise get explicit sign-off that this AC
bullet ships unmet and record it on the issue.

### 4. A newly invited guest does not appear in the new "Guests" section
`app/(app)/week/[id]/week-view.tsx` — `handleInviteGuest` pushes the new
invitation into `invitations`, but `guestEntries` is derived from
`members.filter((m) => m.role === "guest")` and `members` is only loaded once
on mount. So after a successful new-user guest invite the section still reads
"No guests invited for this week yet" until a manual reload; the only visible
feedback is the `accountSetupUrl` blob. Either refetch
`/api/church-group/members` on success or append a local directory entry from
the response (`guestUserId` + `email`).

---

## Verified correct (I checked these myself, not just the summaries)

- **`accept_invitation` supersede is faithful.** I extracted both function
  bodies and diffed them: the only changes are the `v_invitee_role`
  declaration and the guest branch around the `event_attendees` insert.
  Status flip, expiry ordering, notification fan-out, and the audit insert are
  untouched. No other migration defines `accept_invitation`, and
  `20260805000001` sorts last, so nothing is silently reverted.
- **Concurrency in `claim_guest_invitation`.** `SELECT … FOR UPDATE` on the
  placeholder row before the `pending_guest_` / role checks correctly
  serializes two racing claims — the loser gets `ALREADY_CLAIMED`, not a
  double-claim. `email` is never overwritten, so the global unique index can't
  be tripped. Step order matches the spec's numbered list exactly.
- **`middleware.ts`.** `"/guest(.*)"` is anchored at the path start, so it does
  not match `/api/invitations/guest` or `/api/invitations/guest/claim`; both
  stay protected. Confirmed against `createRouteMatcher` semantics and the
  neighbouring `/join(.*)` entry.
- **Anti-enumeration.** All four guest branches return 404, never 403, and the
  service-week lookup keeps the "missing and wrong-group are
  indistinguishable" invariant.
- **The latent `.maybeSingle()` bug is genuinely fixed.** `guestHasWeekAccess`
  awaits an array query with `.limit(1)`, so a re-invited guest with two
  invitation rows for one week no longer 500s. Covered by a real test.
- **`app/api/events/handler.ts`.** The `.in("status", GUEST_ACCESS_STATUSES)`
  filter is applied only for `ctx.role === "guest"`; member/set_leader scoping
  is unchanged, and the tester supplement asserts both directions on the actual
  call arguments.
- **No service-role usage anywhere in the new code** (`check:service-role` OK);
  both new RPCs are `SECURITY DEFINER` with `SET search_path = ''`, fully
  schema-qualified, with the caller-role check (not RLS) as the documented
  enforcement point, matching `remove_church_group_member`'s pattern.
- **`clerk_id` construction** is 46 chars (`pending_guest_` + 32 hex), inside
  `varchar(50)`, and the `md5(random()||clock_timestamp())`-over-`gen_random_uuid()`
  rationale is correct for `search_path = ''`.
- **Removal interaction.** `remove_church_group_member` sets `email = NULL`
  (line 136), so re-inviting a removed member's address provisions cleanly —
  spec edge case 3 holds.

## Non-blocking notes for the record

- The cross-group path returns 409 "A user with this email already exists",
  which is an existence oracle for any address registered anywhere in
  Graceful. `.pipeline/spec.md` edge case 2 accepts this tradeoff explicitly;
  flagging so it is a decision, not an accident.
- Two admins inviting the same brand-new email concurrently: both pass
  `provision_guest_user`'s `EXISTS` check, the loser hits the unique index and
  surfaces a generic error → 500 instead of 409. Mapping SQLSTATE `23505` to
  `EMAIL_TAKEN` would close it.
- `claim_guest_invitation` does not check `response_deadline`. A `pending`
  invitation past its deadline is still claimable; the account is created, then
  `accept_invitation` raises `EXPIRED` — but `pending` is in
  `GUEST_ACCESS_STATUSES`, so that guest still has read access to the week.
  Consistent with how members behave today; worth a follow-up issue rather than
  a change here.
- The migration is not exercised by CI (no local Postgres in the harness), so
  all SQL confidence above comes from reading and diffing, not execution. Worth
  one manual `supabase db push` against a scratch project before merge.
