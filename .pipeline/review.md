# Review — Issue #82: Full E2E regression pass across all Phase 1 critical paths

VERDICT: BLOCK

Reviewed: all four .pipeline artifacts, the full diff of commit ef31bd1, and the
application code every new assertion depends on — the guest-invitation-flow
migration, app/api/invitations/handler.ts, app/api/church-group/join/route.ts,
app/(app)/week/[id]/week-view.tsx, app/(public)/join/[code]/join-form.tsx,
app/(public)/guest/[token]/guest-claim-form.tsx, and the setlist route/handler.

## Independently re-run in this worktree

| Check | Result |
| --- | --- |
| bun run lint | clean, exit 0 |
| bun run typecheck | clean, exit 0 |
| bun run test | 147 suites / 3144 tests, all pass |
| bunx playwright test --list | 15 tests in 11 files, all 3 new specs discovered |

Every green claim in test-results.md reproduces. That is exactly why this is a
BLOCK and not a SHIP: those checks cannot execute a single one of the new specs'
assertions. They prove the files compile, nothing more.

## BLOCKING — B1. guest-invitation.spec.ts Test B asserts the wrong status on re-claim

tests/e2e/guest-invitation.spec.ts:164-167 does:

```ts
const reclaimRes = await guestPage.request.post("/api/invitations/guest/claim", {
  data: { responseToken },
});
expect(reclaimRes.status()).toBe(409);
```

This will fail against real staging. The re-claim is issued from the **same
guest session** that just claimed the token, and claim_guest_invitation
short-circuits that case *before* it ever reaches the ALREADY_CLAIMED branch
(supabase/migrations/20260805000001_guest_invitation_flow.sql):

```sql
-- step 4, line 131
IF v_guest.clerk_id = v_clerk_id THEN
  RETURN jsonb_build_object(..., 'already_claimed', true);
END IF;
...
-- step 6, line 150 — only reachable by a DIFFERENT clerk identity
IF NOT starts_with(v_guest.clerk_id, 'pending_guest_') OR v_guest.role <> 'guest' THEN
  RAISE EXCEPTION 'ALREADY_CLAIMED' USING ERRCODE = 'P0001';
END IF;
```

Step 9 (line 170) sets clerk_id = v_clerk_id at claim time, so on the second
call step 4 matches and the RPC returns successfully. claimGuestInvitation
(app/api/invitations/handler.ts:658-666) therefore returns **201** with
data.alreadyClaimed === true. The 409 mapping at line 646-647 is real, but is
only reachable when a *third-party* Clerk identity tries to claim an
already-claimed invitation — which is not what this test does.

The spec anticipated this exact trap and gave an instruction that was not
followed (spec.md, Test B step 7): "read the claim_guest_invitation migration
and assert whichever it actually does; do not assert both." changes.md states
the 409 was derived from the handler's error mapping, and test-results.md
"independently verified" it by reading *the same handler lines* rather than the
migration the spec pointed at — so the verification step reproduced the coder's
shortcut instead of catching it. This is a green-tests-vs-correct-behavior
failure, and it lands on the one assertion the spec flagged as a required
failure case.

**Fix (tests/e2e/guest-invitation.spec.ts:164-167):** assert the real idempotent
behavior —

```ts
expect(reclaimRes.status()).toBe(201);
const reclaimBody = await reclaimRes.json();
expect(reclaimBody.data.alreadyClaimed).toBe(true);
expect(reclaimBody.data.invitationId).toBe(invitationId);
```

and rewrite the comment above it (which currently cites the wrong mechanism) to
reference migration step 4, not the handler's ALREADY_CLAIMED mapping. If a
genuine non-2xx failure case is still wanted here, use an invalid token
(NOT_FOUND -> 404) rather than re-claiming as the same user.

## BLOCKING — B2. The spec's OPEN QUESTION was never resolved on the record

.pipeline/spec.md still carries, verbatim and uncontradicted:

> ## OPEN QUESTION (blocking — pipeline stops here until a human answers)
> ...
> **Do not proceed past this point without a human answer.**

changes.md opens by asserting "A human resolved it as **Option A**", and the
commit message repeats the claim, but nothing in this repo records that
resolution:

- .pipeline/spec.md was committed unchanged — the OQ is still marked blocking.
- Issue #82 has zero comments (checked via the gh CLI: comments == []).
- There is no "RESOLVED OPEN QUESTIONS (operator decision, <date>)" block, which
  is this repo's own convention for recording one — the previous spec on this
  branch (issue #71) used exactly that pattern, and
  app/(public)/join/[code]/join-form.tsx:7 shows the same convention in product
  code.

AGENTS.md is unambiguous: "every downstream stage stops rather than guessing
until a human resolves it." Either a human really did answer out of band and the
artifact was never updated, or the resolution was assumed. A reviewer cannot
tell those apart from the repo, and that ambiguity is itself the defect — it is
the failure mode already recorded against issue #69.

**Fix:** the operator must confirm the Option A decision, and it must be written
into .pipeline/spec.md (replace the OQ block with a "RESOLVED OPEN QUESTION —
OQ1 (operator decision, <date>)" section stating Option A) before this ships. Do
not simply delete the OQ heading.

## NEEDS WORK — N1. resetDisposablePersona hard-throws in the exact scenario it exists for

The new helper in tests/e2e/support/fixtures.ts throws when the persona's row
resolves to FIXTURE.churchGroupId. But guest-invitation.spec.ts Test B
*deliberately* lands E2E_GUEST_EMAIL inside FIXTURE.churchGroupId — the claim
RPC attaches the placeholder to the fixture group. So:

- If Test B crashes anywhere between the claim (line 139) and its
  teardownFixtures(..., userIds: [guestUserId]), the guest persona is left in
  the fixture group.
- The next run's defensive resetDisposablePersona — at
  guest-invitation.spec.ts:89 *and* week-setup-flow.spec.ts:38, since both specs
  share E2E_GUEST_EMAIL — then throws instead of cleaning up.
- Both specs fail permanently until someone hand-deletes the row in staging.

That directly contradicts the spec's named edge case: "A crashed prior run must
not poison the next one."

**Fix (tests/e2e/support/fixtures.ts, resetDisposablePersona):** keep the hard
guard for role === 'admin' (never cascade-delete the fixture group), but allow
deleting a **non-fixture users row that happens to sit in the fixture group** —
i.e. throw only if row.id === FIXTURE.adminUserId || row.id ===
FIXTURE.memberUserId, and otherwise delete the persona's users row. Group id is
the wrong axis to guard on; the protected things are the two stable fixture user
rows and the group itself.

## NEEDS WORK — N2. Roster-slot scoping is one DOM refactor from silently mis-scoping

week-setup-flow.spec.ts:165 does:

```ts
const joinerRosterSlot = adminPage.getByText(joinerName, { exact: true }).locator("..");
```

I verified this is correct **today**: week-view.tsx:522-539 puts span.memberName
as a direct child of div.rosterSlot alongside the badge and the "+ Invite"
button, and the slot's own text (initials + name + badge + button) will not
match exact: true, so there is no strict-mode ambiguity. The tester's claim
holds.

It is still brittle in two ways worth a cheap hardening pass: ".." breaks
silently the moment anyone wraps the name in an inner div, and joinerName is
derived from Clerk via deriveMemberName (app/api/church-group/join/route.ts:67-77),
whose fallback chain ends at the email local-part — so the assertion's stability
depends on how a human provisions the persona in Clerk.

**Suggested fix:** scope structurally instead, e.g.
adminPage.locator('[class*="rosterSlot"]').filter({ hasText: joinerName }), and
add expect(joinerName).toBeTruthy() after the DB read.

## Things I checked that are correct (not trusting the summaries)

- PUT /api/church-group returns 201 with the raw church_groups row, so
  createGroupBody.data.id is right.
- POST /api/service-weeks returns data.serviceWeek.id
  (app/api/service-weeks/handler.ts:160) and POST .../setlist returns
  data.setlist.id at 201 (setlist/handler.ts:156). The bodyless request.post is
  safe — createSetlist never calls req.json().
- BR-10: anchor ${serviceDate}T00:00:00.000Z, rehearsal -24h/-22h and service
  +0/+2h are all inside the 72h window with end > start.
- /join/:code really has no name field, so the bare "Join group" click is right;
  users.name is server-derived and non-empty by construction (deriveMemberName
  falls back to "Member").
- notification-inbox.spec.ts is the strongest of the three: entity-scoped on
  linkEntityId (not "some unread notification exists"), asserts the idempotent
  re-PATCH, and asserts the cross-user PATCH is exactly 404 — not .ok(), not
  403. DELETE /api/invitations/:id withdraws rather than deletes, so the row
  survives for teardown.
- teardownFixtures FK ordering is right: notifications -> invitations ->
  service_weeks -> songs -> users -> church_groups (last, cascading), with the
  stable-fixture guard.
- Test A's guest-invite assertions match GuestInvitationResponse's real shape,
  and toInvitationResponse does expose responseToken.
- .github/workflows/ci.yml: the two secrets were added to the e2e job's env:
  block only; the check-secrets / has-e2e-secrets gate is untouched.
- D3 honored — zero product-code changes in the diff.
- Gating is correct: e2eDisposablePersonasEnabled requires the base vars plus
  both new ones; notification-inbox and guest Test A gate on e2eAuthEnabled
  only, so they still run without the OQ1 secrets.

## Summary

Fix B1 and B2 to unblock; N1 and N2 belong in the same pass, same files. None of
this is caught by lint / typecheck / Jest / playwright --list — those stay green
through all four defects, because every new assertion sits behind a test.skip.
The first thing that will actually exercise B1 is the first CI run after a human
provisions the two Clerk personas, which is precisely the moment this regression
gate is supposed to be telling the truth about Phase 1.
