# Test Results — Issue #56: Publish setlist (BR-01 zero-song publish)

This overwrites the stale `test-results.md` for issue #61 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Summary

**PASS.** All verification commands are clean and the coder's claims in
`.pipeline/changes.md` hold up under independent re-verification. Added an
independent tester-stage test file that exercises the actual `route.ts` POST
entry points end-to-end (not just the handler functions directly), the
combined BR-01 edge case (zero songs AND zero confirmed members together),
and requireAuth's "lookup resolves to null" 401 branch, which the coder's own
suite did not cover.

## Commands re-run independently

- `bun run lint` — clean, 0 errors / 0 warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run test` — **68 suites / 859 tests pass** (67 suites / 853 tests from
  the coder's existing work, plus 1 new suite / 6 new tests added by this
  stage).

## Independent code read

Read `app/api/setlists/[id]/handler.ts` (both new exports in full),
`app/api/setlists/[id]/publish/route.ts`, and
`app/api/setlists/[id]/unlock/route.ts` line-by-line against
`.pipeline/spec.md`. Confirmed:

- `publishSetlist`: `requireAuth` + `requireRole(["admin", "set_leader"])`
  before any Supabase call; JWT missing → 401 `UNAUTHENTICATED` before
  `getSupabaseClient` is ever constructed; tenant-scoped load
  (`.eq("id", id).eq("church_group_id", ctx.churchGroupId)`); DB error → 500;
  missing row → 404 `"Setlist not found"`; `status !== "draft"` → 409
  `"Setlist is already published."`; update sets both `status: "published"`
  and a fresh `published_at` ISO timestamp in one query, scoped by the same
  two `.eq()`s; song count is a pure read that never blocks publish even when
  it errors-checked separately (500 on error, but a real count of 0 does not
  block); confirmed-members query filters `invitations` by
  `service_week_id = updated.service_week_id` (the *updated* row, i.e.
  post-update, but service_week_id never changes across the update so this is
  equivalent) and `status = "accepted"`, deduped via `Set`; notification
  insert is skipped entirely (table never touched) when `recipientIds.length
  === 0`; `body` is exactly the "still being added" copy iff `songCount ===
  0`, else `null`; return shape is `{ setlist: toSetlistResponse(updated) }`.
- `unlockSetlist`: same auth/tenant-scoped load; `status !== "published"` →
  409 `"Setlist is not published; nothing to unlock."`; update sets
  `status: "draft"` and `published_at: null` together (maintaining the
  invariant that `published_at` is non-null iff `status = "published"`); no
  request body is read at all; no `notifications` table access anywhere in
  the function body.
- Both route files are minimal wrappers (`await params` then delegate),
  matching `app/api/service-weeks/[id]/cancel/route.ts`'s shape exactly —
  confirmed by reading both files directly, and independently proved
  end-to-end (see below) rather than just trusting the visual match.
- `:id` in both routes really is threaded through as the **setlist** id, not
  the service_week id, both by reading the code and by a new test that
  passes a service_week_id as `params.id` and confirms it 404s (fails closed)
  rather than mutating the wrong row or the right row by accident.

## Independent read of the coder's existing tests

Read `tests/unit/app/api/setlists-publish-route.test.ts` in full (23 tests).
Confirmed it genuinely covers, against a stateful in-memory fake (not just a
canned single-fixture mock): happy path with dedupe assertion (2 distinct
recipients from 4 invitation rows including one duplicate-user pair and one
non-accepted row), admin-role parity, BR-01 zero-songs (body copy checked
against the literal string), zero-confirmed-members (asserts zero
notification rows), already-published → 409 with an explicit
zero-notifications assertion, cross-tenant/missing → 404, `member`/`guest` →
403 with no Supabase call, missing JWT → 401 with no Supabase call, and five
distinct 500 paths (load, update, song-count, invitations, notification
insert) — plus the unlock mirror set. No discrepancies found between the
code and what these tests assert; re-ran the file standalone and it passed
before adding anything.

## Independent test coverage added

Added `tests/unit/app/api/setlists-publish-route-tester-supplement.test.ts`
(6 tests, independent stateful fake, no handler-level mocking) covering gaps
the coder's own suite left open:

1. **Route wiring, driven through the real `POST` exports** (not the handler
   functions called directly): two setlist rows exist simultaneously in the
   fake state; calling `publishRoute.POST({params: {id: SETLIST_A_ID}})`
   publishes only `SETLIST_A_ID` and leaves `SETLIST_B_ID` byte-for-byte
   untouched (including its pre-existing `published_at`, proving no
   re-stamping); symmetric test for `unlockRoute.POST`.
2. **Wrong-id-family failure case**: calling `publishRoute.POST` with a
   `service_week_id` (a real id in the fixture, just not a `setlists.id`) as
   `params.id` returns 404 and leaves all rows unchanged — proves the route
   fails closed rather than silently no-op'ing or mutating an unintended row
   if the id-family were ever confused in a future refactor.
3. **Combined BR-01 edge case**: zero songs AND zero confirmed members
   together (both axes empty simultaneously, not just each tested in
   isolation as in the coder's suite) — still 200 published, zero
   notification rows inserted.
4. **`requireAuth` lookup-resolves-to-null 401 branch**: a Clerk user with a
   valid JWT but no matching `users` row (not yet provisioned) — a distinct
   code path from "missing JWT" that the coder's suite never exercised —
   returns 401 `UNAUTHENTICATED` before any Supabase call, for both
   `publishSetlist` and `unlockSetlist`.

All 6 new tests pass against the current implementation with no code changes
required; run standalone and as part of the full suite.

## Failure cases exercised

Per the pipeline contract's requirement to cover at least one failure case,
the following were confirmed (both pre-existing in the coder's suite and
newly added by this stage):

- Already-published setlist → publish returns 409 CONFLICT, no notification
  rows inserted (pre-existing, re-run and confirmed).
- Draft setlist → unlock returns 409 CONFLICT (pre-existing, re-run and
  confirmed).
- Cross-tenant / missing setlist → 404 NOT_FOUND on both endpoints
  (pre-existing, re-run and confirmed).
- `member`/`guest` roles → 403 FORBIDDEN before any DB call (pre-existing,
  re-run and confirmed).
- Missing JWT → 401 UNAUTHENTICATED before any DB call (pre-existing,
  re-run and confirmed).
- Every Supabase `.error` branch (load, update, song-count, invitations,
  notification insert on publish; load, update on unlock) → 500 INTERNAL
  (pre-existing, re-run and confirmed).
- A route call with an id from the wrong id-family (service_week_id passed
  as the setlist `:id`) → 404, not a mistaken publish (new, this stage).
- `requireAuth` lookup returning null (unprovisioned user) → 401
  UNAUTHENTICATED, distinct from the missing-JWT path (new, this stage).

No failures found. Nothing was patched around — the implementation matches
the spec on every point checked. Ready for Review.
