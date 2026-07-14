# Test Results — Issue #52: E2E tests for invitation & conflict flows

This overwrites the stale `test-results.md` for issue #50 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Summary

**ALL CHECKS PASS.** The coder's verification claims in `.pipeline/changes.md` were
independently reproduced, plus one gap was closed (see "Tester-added coverage"
below): the delivered E2E spec files, their support helpers, the CI wiring, and the
env-gating logic are all correct and internally consistent with the actual schema,
RPCs, and route handlers in this repo.

## Context: what "testing" means for this issue

Issue #52's deliverable *is* a Playwright E2E test suite that requires real staging
Clerk + Supabase secrets to actually execute its assertions. Those secrets are not
present in this sandbox (by design — see `tests/e2e/support/env.ts`), so, per
`changes.md`'s own "What the Tester should focus on" section, this pass focused on:
(1) re-running every static/local check the coder claimed, (2) a from-scratch cross
-reference of every DB field/enum/route-response-shape the specs assert against
the actual migrations and handlers (not trusting the coder's inline comments), and
(3) adding new, independently-written Jest unit tests for the one piece of new
logic in this change that *can* run locally without staging secrets
(`tests/e2e/support/env.ts`'s `checkEnv`/`requireEnv`/`e2eAuthEnabled`), to satisfy
the pipeline contract's requirement for happy path / edge cases / a failure case.

## Static/local checks (re-run independently)

| Check | Result |
| --- | --- |
| `bun run typecheck` | PASS (clean, no errors) |
| `bun run lint` | PASS (clean, no errors) |
| `bun run test` (Jest) | PASS — 48 suites / 529 tests (47/520 pre-existing + 1 new suite/9 new tests added by this Tester pass) |
| `bun run check:workflows` | PASS |
| `bun audit --audit-level=high` | PASS — no vulnerabilities |
| `bun install --frozen-lockfile` | PASS — lockfile matches `package.json` exactly, no drift |
| `bunx playwright test --list` | PASS — all 7 tests (4 new specs' 5 tests + `health.spec.ts` + skipped SMS/email placeholder) discovered with no module-resolution/syntax errors |
| `bunx playwright test tests/e2e/health.spec.ts` | PASS — pre-existing unauthenticated E2E test still passes against local `bun run dev`, confirming `playwright.config.ts`'s `webServer`/`workers: 1`/`fullyParallel: false`/`globalSetup` changes don't break it |
| `bunx playwright test` (full suite, local, no staging secrets) | PASS — 1 passed (`health.spec.ts`), 6 skipped (all issue #52 tests, including the always-skip SMS/email placeholder), confirming `globalSetup.ts` no-ops cleanly and every new spec's `test.skip(!e2eAuthEnabled, ...)` / `test.skip(!cronReady, ...)` gate fires correctly with zero secrets configured |
| `.github/workflows/ci.yml` YAML syntax | PASS — parses cleanly (`yaml.safe_load`) |

All of the coder's `changes.md` "Verification performed" claims reproduce exactly.

## Logic/cross-reference review (independent — not just re-running coder's commands)

Read every new file (`tests/e2e/support/{env,db,auth,fixtures,global-setup}.ts`,
all 4 new spec files) and cross-checked every DB/API assumption against the actual
current repo state rather than trusting the inline comments:

- **Schema fields**: `invitations.denial_reason`, `.response_token`,
  `.last_reminded_at` (added by `20260713000001_invitation_reminder_scheduler.sql`),
  `conflicts.trigger_reason`/`.invitation_id`, `notifications.link_entity_id`/`.type`/
  `.body`, `users.anonymized_at` (added by `20260710000001_member_removal_rpc.sql`,
  not in the original Cluster-1 migration — verified this one specifically since
  `fixtures.ts`'s upsert relies on it) all exist exactly as the specs/fixtures assume.
- **`notification_type` enum**: `invitation_accepted`, `invitation_reminder`,
  `scheduling_conflict` (asserted in the accept/reminder/conflict specs) are all
  valid enum values (`20260702000005_cluster_5_partial.sql` +
  `20260713000001_conflict_notification.sql`).
- **RPC → notification linkage**: `record_availability_conflict`'s notification
  insert uses `link_entity_type: 'conflict'`, `link_entity_id: v_conflict_id` and
  excludes the triggering user (`id <> v_user_id`) even for admin/set_leader roles
  — exactly what `conflict-detection.spec.ts`'s two tests assert.
  `send_invitation_reminders`'s admin notification uses
  `link_entity_id: v_week.id` (service week, not invitation) and a `body` built
  from `string_agg(u.name, ...)` — matches `invitation-reminder.spec.ts`'s
  `.eq("link_entity_id", serviceWeekId)` and `.toContain("E2E Fixture Member")`.
- **API response shapes**: `POST /api/invitations/:id/accept` and `.../deny` both
  return `alreadyResponded` (camelCase, from `data.already_responded`) exactly as
  `invitation-accept.spec.ts`/`invitation-deny.spec.ts` assert;
  `PUT /api/availability` returns `conflictTriggered`; `GET /api/conflicts` returns
  `{ data: { conflicts: [{ id, invitationId, triggerReason }] } }` — all match
  `conflict-detection.spec.ts` field-for-field.
- **UI selectors**: `app/(public)/invite/[token]/invite-response.tsx` renders
  exactly the button text (`"Accept"`, `"Decline"`, `"Confirm decline"`), label
  (`"Reason (optional)"` via `htmlFor="decline-reason"` / `id="decline-reason"`),
  and heading text (`"You're on the schedule"`, `"Response recorded"`) that
  `invitation-accept.spec.ts`/`invitation-deny.spec.ts` locate via `getByRole`/
  `getByLabel`.
- **`fixtures.ts`'s unique-`clerk_id` architectural claim**: confirmed
  `users.clerk_id` is genuinely `unique` in `20260702000001_cluster_1_organization.sql`,
  so the stable-fixture-plus-per-test-cleanup design (vs. the RLS suite's
  per-test-fresh-fixture design) is a real, correctly-reasoned constraint, not an
  invented justification.
- **`GET /api/notifications` 501-stub claim**: confirmed
  `app/api/notifications/route.ts` is genuinely an unimplemented `501` today,
  justifying the specs' direct-DB-read workaround for notification assertions.
- **CI YAML**: `e2e` job's `if: needs.check-secrets.outputs.has-e2e-secrets == 'true'`
  correctly depends on `check-secrets`, which now computes `has-e2e-secrets` from
  `STAGING_APP_URL` (mirrors the existing `has-secrets`/`rls-integration` pattern
  exactly); all 8 required secrets (7 from `env.ts` + `CRON_SECRET`) are wired into
  the job's `env:` block with matching names.
- **`package.json`/`bun.lock`**: `@clerk/testing` and `@clerk/backend` are
  correctly-scoped devDependencies; `test:e2e` script exists (`playwright test`);
  `bun install --frozen-lockfile` succeeds with zero drift.

No discrepancies found between what the spec files assert and the actual current
behavior of the app.

## Tester-added coverage

The pipeline contract requires this stage to cover "the happy path, the edge cases
the spec named, and at least one failure case," but the delivered E2E specs
themselves cannot execute any assertions in this sandbox (no staging secrets) —
only `--list`/static verification was possible for them, per `changes.md`'s own
scoping note. To meet the contract with something that *actually runs and can
fail*, added a new Jest unit-test file (not touching any coder-delivered file):

**`tests/unit/e2e-support/env.test.ts`** (9 tests, all passing) — exercises
`tests/e2e/support/env.ts`'s `checkEnv`/`e2eAuthEnabled`/`requireEnv`, the one piece
of genuinely new logic in this change that has no staging dependency:
- Happy path: `checkEnv()` / `e2eAuthEnabled` are `true` when all 7 required vars
  are set; `requireEnv` returns the value when present.
- Edge cases (named implicitly by the module's own contract): `checkEnv()` is
  `false` when even one required var is missing; `checkEnv(["CRON_SECRET"])`
  correctly requires the spec-specific extra on top of the base 7 (this is exactly
  the mechanism `invitation-reminder.spec.ts`'s `cronReady` gate depends on);
  `e2eAuthEnabled` is `false` with zero secrets configured (the actual state of
  this sandbox and of local/CI-without-staging runs); an empty-string var is
  correctly treated as absent, not merely-present-but-falsy-checked differently.
- Failure case: `requireEnv` throws `"Missing required env var for E2E tests: <name>"`
  when the var is absent — this is the failure mode every seeding helper in
  `fixtures.ts`/`auth.ts`/`db.ts` relies on to fail loudly rather than silently
  proceeding with `undefined` credentials against staging.

This is genuinely new test coverage (not a duplicate of anything in `changes.md`),
runs in the normal `bun run test` (Jest) path with no secrets required, and is
included in the 529-test total reported above.

## Verdict

**PASS.** No failures, no regressions, no schema/API mismatches found. Recommend
proceeding to Review. Flagging one observation for the Reviewer's judgment (not a
failure): this Tester, like the Coder, cannot exercise the actual staging-dependent
assertions (real Clerk sign-in, real conflict RPC round-trip, etc.) without
provisioned secrets — the review of correctness here is necessarily static
(schema/route/UI cross-reference) rather than a live run of those 6 gated tests.
