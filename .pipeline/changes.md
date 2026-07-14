# Changes — Issue #52: E2E tests for invitation & conflict flows

## Human resolution applied (overriding the planner's OPEN QUESTIONS)

- **OQ1 (auth):** Added `@clerk/testing` + `@clerk/backend` (devDependencies).
  E2E specs sign real Playwright browser sessions in against seeded staging
  Clerk **test-mode** users via `@clerk/testing/playwright`'s
  `clerk.signIn({ page, emailAddress })` (ticket-based, no password needed).
- **OQ2 (AC#2 deny):** Only the observable part is tested — invitation flips
  to `denied` with the given reason. Admin SMS+email is NOT asserted; added
  an always-skipped placeholder test in `invitation-deny.spec.ts` naming
  #67/#68 as the tracked reason. #67/#68 were NOT implemented.
- **OQ3 (AC#3 reminder):** Seeds an invitation with a backdated `created_at`
  (25h ago) via the service-role client, calls
  `GET /api/cron/invitation-reminders` with `CRON_SECRET`, and asserts only
  the admin in-app reminder + `last_reminded_at` stamping (member-SMS
  assertion dropped).
- **OQ4 (CI):** Added a secrets-gated `e2e` job to `ci.yml` mirroring the
  `check-secrets` → `rls-integration` pattern, plus staging `baseURL` wiring
  in `playwright.config.ts`.

## Files created

- `tests/e2e/support/env.ts` — env-var gating (`e2eAuthEnabled`, `checkEnv`,
  `requireEnv`) for the whole staging-authenticated suite; mirrors
  `tests/integration/rls/setup.ts`'s `rlsTestsEnabled` pattern. Every spec
  file `test.skip(!e2eAuthEnabled, ...)`s when staging secrets are absent
  (local runs), so this issue's new tests never fail a local `bun run
  test:e2e` or a CI run without staging provisioned.
- `tests/e2e/support/db.ts` — service-role Supabase client factory scoped to
  new `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY` secrets (distinct
  from the RLS suite's `SUPABASE_TEST_*`, since the RLS job applies
  migrations fresh to a scratch DB each run, while this needs the *real*
  staging project). Mirrors `tests/integration/rls/client.ts`.
- `tests/e2e/support/auth.ts` — `signInAs(page, "admin" | "member")` wrapping
  `@clerk/testing/playwright`'s `clerk.signIn`.
- `tests/e2e/support/fixtures.ts` — seeding/teardown. **Important
  architectural note for the tester:** `users.clerk_id` is a UNIQUE column
  (`supabase/migrations/20260702000001_cluster_1_organization.sql`), and the
  admin/member Clerk identities are real, pre-provisioned staging accounts —
  so, unlike the RLS suite's fake per-tenant clerk_ids, tests can't mint a
  fresh church_group + admin/member trio per test without colliding on that
  constraint. Instead there is ONE stable fixture (`FIXTURE` — fixed church
  group + admin + member IDs), idempotently upserted once in
  `global-setup.ts`; every test seeds+tears down only its own
  service_week/invitation/conflict/notification/availability rows with fresh
  UUIDs. This is also why `playwright.config.ts` now pins `workers: 1` /
  `fullyParallel: false` — tests must not touch the shared admin/member rows
  concurrently (the conflict self-exclusion test temporarily elevates the
  member's role and reverts it in a `finally`).
- `tests/e2e/support/global-setup.ts` — Playwright `globalSetup`: calls
  `clerkSetup()` (Clerk testing-token bypass) and `ensureChurchFixture()`,
  both skipped when `!e2eAuthEnabled`.
- `tests/e2e/invitation-accept.spec.ts` (AC#1) — public token-flow accept via
  `/invite/[token]`; asserts DB status flip + admin notification row (see
  notifications caveat below) + accept-again idempotency via the API.
- `tests/e2e/invitation-deny.spec.ts` (AC#2) — public token-flow decline;
  asserts `denied` status + `denial_reason` + idempotency, plus the
  always-skipped SMS/email placeholder described above.
- `tests/e2e/invitation-reminder.spec.ts` (AC#3) — backdates an invitation,
  hits the cron route directly, asserts the admin reminder notification and
  that a second immediate call does NOT re-stamp `last_reminded_at`.
- `tests/e2e/conflict-detection.spec.ts` (AC#4) — two tests: (1) member
  (Clerk-authenticated) marks an accepted service date unavailable via
  `PUT /api/availability`; admin (separately Clerk-authenticated) reads the
  real `GET /api/conflicts` endpoint and the notification row; (2) the named
  spec edge case that the triggering member never gets a self-notification
  even while holding `set_leader` (temporarily elevates the shared member's
  role for this one test only).

## Files modified

- `playwright.config.ts` — `STAGING_APP_URL`-based `baseURL` (falls back to
  `NEXT_PUBLIC_APP_URL`/localhost); skips `webServer` when targeting staging;
  added `globalSetup`; switched `fullyParallel: true` → `false` and added
  `workers: 1` (required by the shared-fixture architecture above — same
  justification the RLS suite already uses via `maxWorkers: 1`).
- `.github/workflows/ci.yml` — `check-secrets` now also outputs
  `has-e2e-secrets` (gated on `STAGING_APP_URL`); new `e2e` job (gated on
  that output) installs Playwright browsers and runs `bun run test:e2e`
  against staging. No Vercel deploy step added (per
  `documentation/staging-environment.md` §3).
- `documentation/staging-environment.md` — new `## 7. Playwright E2E tests`
  section documenting the 7 new/reused secrets the `e2e` job needs and the
  OQ2/OQ3 scope notes; renumbered the old `## 7. Verification checklist` to
  `## 8`.
- `package.json` / `bun.lock` — added `@clerk/testing` and `@clerk/backend`
  devDependencies.
- `.gitignore` — gained a `/.clerk/` entry. This was auto-appended by
  Clerk's own Next.js dev-server tooling the first time `next dev` ran
  locally during verification (Clerk's "keyless mode" local state dir), not
  a deliberate edit; kept because it's a correct, harmless addition (a local
  secrets-adjacent directory that should never be committed).

## Notable implementation decision not covered by an OPEN QUESTION

`GET /api/notifications` (and the rest of the notifications API) turned out
to be an unimplemented `501` stub (`app/api/notifications/route.ts`), even
though the planner's spec listed it as an observable surface. Since
implementing it is out of scope for #52, admin in-app notification
assertions read the `notifications` table directly via the service-role
client instead — this is the same "assert backend state directly" pattern
`tests/integration/rls` already uses, just applied here because the app-level
read path doesn't exist yet. Documented in `staging-environment.md` §7 and in
comments at each assertion site. The conflict-detection test still exercises
the real `GET /api/conflicts` endpoint (which IS implemented) for its
non-notification assertions.

## Verification performed

- `bun run typecheck` — pass
- `bun run lint` — pass
- `bun run test` — 47 suites / 520 tests pass (no regressions)
- `bun run check:workflows` — pass
- `bun audit --audit-level=high` — no vulnerabilities
- `bunx playwright test --list` — all 7 new/existing E2E tests discovered
  correctly (module resolution, `test.skip` gating verified)
- `bunx playwright test tests/e2e/health.spec.ts` — still passes locally
  (confirms the `webServer`/`workers`/`fullyParallel` config changes don't
  break the existing unauthenticated E2E test)

## What the Tester should focus on

- The four new spec files all `test.skip` in this sandbox (no staging
  secrets configured) — the Tester cannot exercise the real Clerk
  sign-in/staging-seeding paths end-to-end without those secrets. Focus
  verification on: static correctness (typecheck/lint), that `--list`
  resolves all tests without runtime errors, that `health.spec.ts` still
  passes, and a careful logic review of `tests/e2e/support/fixtures.ts`
  (the unique-`clerk_id` constraint reasoning) and the RPC/schema
  cross-references in each spec (e.g. `conflictTriggered` field name,
  `notifications.type` values, `/api/conflicts` response shape).
- Confirm the CI YAML is syntactically valid and the new `e2e` job's `if`
  condition correctly gates on `check-secrets`.
