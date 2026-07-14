# Spec — Issue #52: E2E tests for invitation & conflict flows

> Planner note: I inspected the actual repo state (handlers, RPC migrations,
> notification stubs, Playwright config, CI). This issue as written cannot be
> fully implemented today: two of the four required tests assert behavior the
> app does not yet perform, and there is no mechanism to authenticate a real
> browser against staging. These are genuine blocking ambiguities, not
> guessable details — the pipeline must stop here until a human resolves the
> OPEN QUESTIONS below.

## OPEN QUESTIONS (must be resolved by a human before coding)

### OQ1 — How do E2E tests sign in against staging? (blocks all four tests)
The issue says "Reuse the auth-matrix test harness pattern from #32 for minting
test sessions." That harness is `tests/support/api-auth.ts`, and it is a
**Jest-only mock** of `@clerk/nextjs/server`'s `auth()` (`mockClerkAuthed` /
`mockClerkAnonymous`, using `jest.fn()`). It cannot authenticate a real browser
against a real Clerk instance on staging. There is currently:
- no Playwright/browser session-minting helper anywhere in the repo,
- no `@clerk/testing` dependency (not in `package.json`),
- no seeded staging test users and no credentials for them.

A human must choose the approach and provision what it needs, e.g. adding
`@clerk/testing` (`setupClerkTestingToken`) plus seeded staging test users and
Clerk **test-mode** keys, or a documented session-injection path. Until this is
decided, none of the four browser tests can log in. Note the health-check E2E
test (`tests/e2e/health.spec.ts`) is unauthenticated and gives no precedent for
authenticated flows.

### OQ2 — AC #2 (deny → admin receives SMS + email with reason): nothing to test
The deny handler does not send SMS or email. `app/api/invitations/handler.ts`
(~line 399) still reads `// TODO(#67/#68): dispatch SMS + email to invited_by`.
Both dispatch primitives are unimplemented stubs that *throw*:
- `lib/pingram/client.ts` → `sendSms` throws `"sendSms not implemented — see Sprint 4 #58"`.
- `lib/resend/client.ts` → `sendEmail` throws `"sendEmail not implemented — see Sprint 4 #59"`.

The AC hedges "(once #67/#68 exist…)"; they do not exist, and #52 does not list
#67/#68 as dependencies or claim them as in-scope. Decision needed: either
(a) defer AC #2's SMS+email assertions — test only the observable parts today
(slot reopens to `denied`, and the admin's in-app signal, if any) or skip the
test with a tracked reason — or (b) explicitly expand this issue's scope to
implement #67/#68 (SMS/email dispatch), which is not currently in scope.

### OQ3 — AC #3 (24h reminder, both member AND admin): partially untestable
- Admin side is real: `send_invitation_reminders` RPC
  (`supabase/migrations/20260713000001_invitation_reminder_scheduler.sql`)
  inserts admin in-app notifications and stamps `last_reminded_at`.
- Member side is SMS via the same throwing `sendSms` stub; the cron route
  (`app/api/cron/invitation-reminders/route.ts`) deliberately swallows the
  failure (`smsFailed`). So "member receives a reminder" cannot be verified
  E2E until #58.
- "time mocked to advance 24 hours" is not achievable against a remote staging
  server from Playwright — the reminder selector uses server `now()`
  (`lib/scheduling/reminder.ts` `isReminderDue`, mirrored in SQL). The only
  viable trigger is to seed/backdate an invitation's `created_at` via the
  service-role client so it is already due, then call
  `GET /api/cron/invitation-reminders` with the `CRON_SECRET` bearer token.
  A human must confirm this backdating approach is acceptable and that the
  member-SMS assertion is dropped/deferred (leaving only the admin in-app
  reminder as the assertion).

### OQ4 — Is staging (#13) provisioned, and what secrets does CI have?
AC #5 requires the four tests to "run against staging and pass in CI."
Today:
- `playwright.config.ts` targets a local `bun run dev` server via
  `NEXT_PUBLIC_APP_URL` (default `http://localhost:3000`); there is no
  staging baseURL/project wiring.
- `.github/workflows/ci.yml` has **no** Playwright job (only typecheck, lint,
  `check:workflows`, `test:coverage`, `bun audit`, and a secrets-gated
  `rls-integration` job).
- `documentation/staging-environment.md` says Vercel owns deploys and CI must
  NOT add a deploy job, but is silent on an E2E job and its secrets.

A human must confirm (a) staging (#13) is actually deployed/reachable, and
(b) which secrets are available to GitHub Actions for an E2E job — at minimum:
staging base URL, Clerk test-mode keys + test-user credentials (per OQ1),
`CRON_SECRET` (per OQ3), and a service-role key for seeding/teardown. Follow
the existing secrets-gated pattern in `ci.yml` (`check-secrets` job →
`if: needs.check-secrets.outputs.has-secrets == 'true'`) so the job is skipped,
not failed, when secrets are absent.

---

## Current state (verified — for whoever resolves the above)

What the app ACTUALLY does today, so the resolver knows which ACs have real
behavior behind them:

| AC | Flow | Backing implementation | E2E-testable today? |
| -- | ---- | ---------------------- | ------------------- |
| #1 | accept → Confirmed → admin in-app notification | `accept_invitation` RPC (`supabase/migrations/20260712000001_accept_invitation_rpc.sql`) does status flip + `event_attendees` insert + admin in-app notify + audit log | Yes (behavior exists); blocked only by OQ1 auth |
| #2 | deny → slot reopens → admin SMS + email | Slot reopen = `status:'denied'` real (`denyInvitation`); **SMS + email NOT implemented** (OQ2) | Partially — SMS/email cannot be asserted |
| #3 | 24h reminder → member + admin | Admin in-app reminder real; member SMS stubbed/throws (OQ3); time cannot be mocked remotely (OQ3) | Partially — admin only |
| #4 | confirm → mark unavailable → admin conflict notification → slot reopens | `record_availability_conflict` RPC (`supabase/migrations/20260713000001_conflict_notification.sql`) inserts `scheduling_conflict` in-app notification to admins/set_leaders | Yes (behavior exists); blocked only by OQ1 auth |

Sprint-2 screen/state-machine dependencies appear satisfied:
`app/(app)/week/[id]/week-view.tsx` (#48), `app/(public)/invite/[token]/`
+ `app/api/invitations/[id]/deny` (#49),
`app/(app)/conflicts/[id]/conflict-resolution.tsx` (#50),
`lib/invitations/state-machine.ts` (#51). In-app notifications are observable
via `app/(app)/notifications/page.tsx`, `GET /api/notifications`, and
`GET /api/notifications/unread-count`.

---

## Conditional implementation plan (only after OQ1–OQ4 are resolved)

Scaffolding guidance for the coder once a human answers above; do NOT build it
while the OPEN QUESTIONS stand.

### Files to create
- `tests/e2e/invitation-accept.spec.ts` — AC #1.
- `tests/e2e/invitation-deny.spec.ts` — AC #2 (scope per OQ2 resolution).
- `tests/e2e/invitation-reminder.spec.ts` — AC #3 (scope per OQ3 resolution).
- `tests/e2e/conflict-detection.spec.ts` — AC #4.
- `tests/e2e/support/` — E2E-only helpers: (a) the browser auth helper decided
  in OQ1, and (b) a service-role seeding/teardown helper for staging fixtures.

### Files to modify
- `playwright.config.ts` — add staging `baseURL` wiring and (per OQ4) any
  project/reporter config; keep the existing `NEXT_PUBLIC_APP_URL` fallback.
- `.github/workflows/ci.yml` — add a secrets-gated E2E job mirroring the
  existing `check-secrets` → gated-job pattern; install Playwright browsers
  (`bunx playwright install --with-deps`) and run `bun run test:e2e`
  (script already exists in `package.json`). Do NOT add a Vercel deploy step
  (`documentation/staging-environment.md` §3).

### Patterns to follow (name-checked)
- Test structure/imports: `tests/e2e/health.spec.ts`
  (`import { test, expect } from "@playwright/test"`).
- Service-role seeding + stable fixture IDs + per-test cleanup discipline:
  `tests/integration/rls/setup.ts` and `tests/integration/rls/client.ts`
  (`getServiceClient`). Reuse its seed persona shape (admin/member in one
  church group) rather than inventing new fixtures.
- Secrets-gated CI job: the `check-secrets` + `rls-integration` jobs in
  `.github/workflows/ci.yml`.
- Cron trigger for the reminder test (OQ3): `Authorization: Bearer <CRON_SECRET>`
  against `GET /api/cron/invitation-reminders` (see the route's auth check).

### Edge cases the tests must handle (once unblocked)
- Each test seeds its own fixture and tears it down (or uses uniquely-suffixed
  identifiers) — staging is shared and long-lived; do NOT rely on a pristine DB
  or mutate another test's rows (mirror the isolation discipline in the RLS
  suite).
- Notification assertions must scope to the specific admin recipient and the
  specific entity (`link_entity_id`), not just "an unread notification exists,"
  to avoid cross-test bleed on shared staging.
- Reminder test must assert the invitation was stamped `last_reminded_at` and
  is not double-reminded on a second cron call within the window.
- Conflict test: the triggering member must NOT receive a self-notification
  even if they also hold an admin/set_leader role (the RPC excludes the
  triggering user: `id <> v_user_id`).
- Deny idempotency: a second deny/accept on an already-responded invitation is
  a no-op returning current status (per `denyInvitation` / `accept_invitation`).
</content>
