# Test Results — Issue #54: Draft setlist creation (BR-01 zero-song valid state)

This overwrites the stale `test-results.md` for issue #53 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: PASS

All checks re-run independently from a clean read of the spec, changes.md,
and the actual diff (not just the coder's claims).

## What was independently verified

1. **Static checks** — re-ran from scratch:
   - `bun run lint` — clean, no errors/warnings.
   - `bun run typecheck` — clean, no errors.

2. **Existing coder test suite** — re-ran
   `tests/unit/app/api/service-weeks-setlist-route.test.ts` (16 tests) and the
   full suite:
   - `bun run test` — **53 suites / 603 tests, all passed** (52 suites / 596
     tests before my supplementary file was added, +1 suite / +7 tests after).

3. **Source cross-check against the spec's factual claims** (not just trusted
   from changes.md):
   - `supabase/migrations/20260702000003_cluster_3_scheduling_core.sql`:
     confirmed `setlists` table exists with `service_week_id uuid not null
     unique`, `status setlist_status not null default 'draft'`,
     `church_group_id`, `published_at`, `notes`, `created_by`, timestamps —
     matches spec exactly. No migration was added or needed; correct.
   - `supabase/migrations/20260704000001_rls_policies.sql` lines ~160-181:
     confirmed `setlists_select_published_members` (members/guests see
     `status = 'published'` only; leaders/admins see all via
     `auth_is_leader_or_admin()`) and insert/update/delete restricted to
     leader/admin. Matches spec.
   - `app/api/service-weeks/handler.ts` `createServiceWeek`: confirmed a
     draft setlist row (`church_group_id`, `service_week_id`, `created_by`,
     no `status` — DB default applies) is already inserted at service-week
     creation time. Confirms the "auto-create already exists, POST is a
     get-or-create safety net" design decision is factually accurate, not
     just asserted.
   - `app/api/service-weeks/[id]/setlist/handler.ts` and `route.ts`: read in
     full; logic matches spec section-by-section (auth/JWT/role gating,
     query shapes, get-or-create flow, insert payload, error mapping, no
     `req.json()` read).

4. **Independent supplementary tests** — wrote and ran
   `tests/unit/app/api/service-weeks-setlist-route-tester-supplement.test.ts`
   (new, 7 tests, all passing). Written independently because the coder's own
   `makeChain` mock in their test file has a no-op `.eq()` passthrough that
   ignores its arguments and always returns the configured fixture regardless
   of what's actually queried — so a bug where a handler forgot to scope a
   query by `church_group_id` (a cross-tenant leak, or a setlist created
   pointing at another tenant's week) would NOT have been caught by the
   existing suite. My supplement uses a recording chain that asserts on the
   actual arguments passed to `.eq()`/`.insert()`:
   - `getSetlist` scopes the `setlists` query by `service_week_id` AND the
     caller's own `church_group_id` (not a fixed/wrong tenant) — asserted via
     captured `.eq()` call arguments.
   - `getSetlist` does not query `invitations` at all for non-guest roles
     (admin/leader/member) — confirms the invitation check is guest-only, not
     just "returns 200 for guest-with-invitation" as the coder's suite shows.
   - `createSetlist`'s tenant-scoped week-existence check filters by `id` AND
     the caller's own `church_group_id` — asserted via captured `.eq()`
     arguments, closing the gap where a hardcoded/wrong tenant filter would
     have passed the coder's own fixture-based tests.
   - `createSetlist` never touches the `setlists` table at all when the
     week-existence check returns 404 (call-order / short-circuit
     verification, not just the final status code).
   - Insert payload for a new draft setlist has no `status` key at all
     (`Object.prototype.hasOwnProperty` check) — confirms the DB default is
     relied on rather than a value silently included that happens to equal
     `'draft'`.
   - `POST` never calls `req.json()` — verified by passing a request object
     whose `.json()` throws if invoked, confirming BR-01's "no body read"
     claim structurally rather than just by code inspection.
   - End-to-end double-POST idempotency across two separate `createSetlist`
     invocations against a shared simulated DB state: first call inserts once
     and returns 201; second call performs zero additional inserts and
     returns 200 with the same setlist id. This is a stronger version of the
     coder's single-call "existing -> 200" test because it drives the
     insert-then-reread sequence across two real calls rather than
     pre-seeding the "already exists" fixture.

## Coverage against spec's named edge cases

- Zero-song / no-body POST semantics — verified (own test + code read).
- One setlist per week / get-or-create idempotency — verified (own test,
  including a true double-call, not a single pre-seeded read).
- Members/guests can't see a draft, 404 not 403 — verified (coder's tests +
  code read of RLS policy).
- Guest without invitation for the week -> 404 not 403 — verified (coder's
  tests).
- Cross-tenant / nonexistent week id on POST -> 404 before any insert —
  verified (coder's test for null lookup + my own call-order test proving
  `setlists` is never touched).
- Supabase query/insert errors -> 500 INTERNAL — verified (coder's tests,
  both suites: 401/403/404/500 failure paths all exercised).

## Files added by this stage

- `tests/unit/app/api/service-weeks-setlist-route-tester-supplement.test.ts`
  (new, 7 tests, independent of the coder's test file).

## Notes for the Reviewer

No regressions, no failures, no code changes made by this stage (per the
pipeline contract, testing does not patch the implementation). One
observation worth reviewer attention, not a blocker: `createServiceWeek`'s
auto-create setlist insert and this issue's `createSetlist` get-or-create
insert both omit `status` and rely on the DB default — consistent, but if
that DB default column is ever changed/removed, both call sites need
updating; not in scope for #54 to fix.
