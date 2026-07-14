# Review — Issue #52: E2E tests for invitation & conflict flows

VERDICT: SHIP

## Summary

High-quality change. The planner correctly identified this issue could not be
built as literally written and raised OQ1–OQ4; the coder's `changes.md` records
a human resolution for each (add `@clerk/testing`+`@clerk/backend`, seed staging
Clerk test users, scope AC#2 to the observable `denied` flip, scope AC#3 to the
admin in-app reminder via a backdated `created_at` + cron call, add a
secrets-gated CI job). Every resolution is reasonable and correctly scoped to
#52 — #67/#68 (SMS/email) were NOT pulled in, and there is no scope creep.

I did not trust the written summaries. I re-derived the load-bearing
cross-references against the actual repo and they all hold:

- `ok()` wraps payloads in `{ data }` (`lib/api/response.ts`); accept/deny
  handlers return `{ status, alreadyResponded }` (`handler.ts:317`, `:566`) —
  matches `invitation-accept/deny.spec.ts`.
- `PUT /api/availability` returns `conflictTriggered`
  (`app/api/availability/handler.ts:177`) — matches the conflict spec.
- `GET /api/conflicts` returns `ok({ conflicts: [...] })` with `invitationId`
  and `triggerReason` fields (`app/api/conflicts/handler.ts:101,114,119`);
  `"marked_unavailable"` is a real `ConflictTriggerReason`
  (`lib/scheduling/conflict-detection.ts:10`) — matches field-for-field.
- `notifications` direct-read workaround is justified: `GET /api/notifications`
  is a real 501 stub; the service-role client lives under `tests/` and the
  service-role guard (`scripts/check-service-role.mjs`) only scans `app/`+`lib/`,
  so no guard violation.
- `users.clerk_id` UNIQUE constraint reasoning behind the stable-fixture +
  `workers: 1` design is genuine, not invented.
- `bunx playwright test --list` cleanly discovers all 7 tests; the always-skip
  SMS/email placeholder correctly surfaces the OQ2 gap in the report instead of
  hiding it.

Tests are meaningful, not superficial: notification assertions are scoped to a
specific recipient AND entity id (no "some unread notification exists" bleed),
idempotency and no-double-remind edge cases are asserted, the self-exclusion
edge case is exercised, and every test tears down its own rows in FK order.

## Notes for the human (confirm, but not blocking)

1. **The whole change presupposes the OQ1–OQ4 human resolution.** AGENTS.md
   says downstream stages STOP at OPEN QUESTIONS until a human resolves them.
   `changes.md` asserts that happened, but the only evidence is the coder's
   prose. Before merge, confirm YOU actually approved: adding the two Clerk
   devDependencies, provisioning seeded staging Clerk test-mode users, and
   creating the 8 GitHub Actions secrets. If you did, this is a clean SHIP.
2. **No live E2E assertion has ever executed** — coder and tester both ran only
   static checks + a small `env.ts` unit test, because no staging secrets exist
   in the sandbox. The staging-dependent assertions are verified by
   cross-reference only. This is inherent to shipping secrets-gated scaffolding
   (same posture as the RLS suite) and is acceptable, but the first real CI run
   after provisioning is the true smoke test.
3. **Minor false-green gap in CI gating:** the `e2e` job runs when
   `STAGING_APP_URL` alone is set, but each test skips unless ALL 7 vars in
   `env.ts` are present. If staging URL is set but a Clerk/Supabase secret is
   missing, the job passes green with every test skipped. Mirrors the existing
   single-secret `rls-integration` gate, so not a regression — but worth
   tightening the gate (or having the job fail when partially provisioned) so a
   half-configured secret set can't silently no-op the suite.
4. `.gitignore` gained `/.clerk/` (Clerk keyless-mode local dir) — correct,
   harmless, unrelated-but-defensible.

None of these are code defects. Nothing here can fail a normal local/CI run,
there are no security or correctness issues in the delivered code, and the
suite is correctly written against the real app. Ship after confirming item 1.
