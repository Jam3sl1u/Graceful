# Architecture rules

These are the standing rules for how Graceful reaches its data. The README
summarizes them. This file is the longer note that used to live at the bottom
of the README, updated to match the migrations and route handlers currently
in the tree.

## Request path

The browser renders React through the Next.js App Router. It calls this
app's own `/api/*` handlers. It does not create a Supabase client. The only
`createClient` calls under `app/` and `lib/` are in `lib/supabase/client.ts`,
which is marked `server-only`.

`middleware.ts` runs on every matched request:

- Clerk session check. Routes outside `isPublicRoute` call `auth.protect()`.
- A per-request Content-Security-Policy nonce (`lib/security/csp.ts`).
- An in-memory rate limit for `/api/*` (`lib/api/rate-limit.ts`). Page
  navigations are not rate limited. `/api/health` is exempt.

Each API handler then does three things, in order, when the route accepts
user input:

1. Resolve the caller. `requireAuth` in `lib/api/auth.ts` reads the Clerk
   user id, then loads `users.id`, `users.church_group_id`, and `users.role`
   with that user's JWT. `requireRole` checks the role on the row.
2. Validate the payload. Zod schemas live in `schemas/`. A failed `safeParse`
   returns 400. Rules that are more than shape (event timing, invitation
   transitions, denial cap) run after parsing, in the handler or in SQL.
3. Read and write through `getSupabaseClient(jwt)`. That client uses the
   Supabase anon key plus the Clerk JWT as the `Authorization` bearer, so
   Postgres row-level security sees the same person the handler does.

A few routes cannot call `requireAuth`, because the Clerk user has no
`users` row yet. `PUT /api/church-group`, `POST /api/church-group/join`, and
`POST /api/invitations/guest/claim` still require a Clerk session, then call
a `SECURITY DEFINER` function. Invitation accept and deny can also run with
no session when the body carries a `responseToken`. Those calls use
`getAnonSupabaseClient()` and the token is checked inside the function.

Cron routes (`/api/cron/invitation-reminders` and
`/api/cron/practice-reminders`) have no Clerk session. They require
`Authorization: Bearer <CRON_SECRET>`.

## Database access and the service role

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. It must not be
referenced in `app/` or `lib/`. `scripts/check-service-role.mjs` fails if a
non-comment line in those trees mentions it. The key is expected only in
operator environments, migration or seed tooling, and CI secrets used by the
RLS and Playwright suites. That script is not one of the CI steps. The CI
secret scan is `bun run check:git-secrets` in the `git-secret-scan` job.

Privileged multi-step writes that row-level security cannot express as one
policy are `SECURITY DEFINER` functions in `supabase/migrations/`. Examples:
`create_church_group`, `join_church_group`, `accept_invitation`,
`deny_invitation`, `record_availability_conflict`, `send_invitation_reminders`,
`send_practice_reminders`, and `write_audit_log`. The function body is the
business rule. The Next.js handler is responsible for deciding whether this
caller may invoke it.

## Row-level security

Row-level security is enabled on the application tables, including
`church_groups` (`20260704000002_church_groups_rls.sql`). Authenticated users
can select their own church group. There is no authenticated insert, update,
or delete policy on `church_groups`, so those writes stay on the functions
above.

Other tables are scoped by `auth_church_group_id()` and, where the row is
personal, by `auth_user_id()`. Helper functions prefer a `church_group_id` or
`role` claim on the JWT and fall back to the `users` row. Nothing in `app/`
or `lib/` writes those claims today. `lib/clerk/server.ts` still throws.

`audit_logs` is append-only at the grant layer (`REVOKE UPDATE, DELETE`) and
selectable by admins. `app_secrets` and `practice_reminder_sends` have
row-level security on, no policies, and `REVOKE ALL` from `PUBLIC`, `anon`,
and `authenticated`. The practice-reminder functions read `app_secrets`.

`send_invitation_reminders()` is granted to `anon` and does not take
`CRON_SECRET`. The bearer check for that job lives in the Next.js route.
`send_practice_reminders(text)` and `confirm_practice_reminder_sent(...)` are
also granted to `anon`, and they compare the argument to `app_secrets`
inside the function. The comparison uses ordinary `=` (see the comment in
`20260831000002_practice_reminder_scheduler.sql`).

## Supabase Data API

`supabase/config.toml` sets `[api] enabled = false` for a local
`supabase start` stack. The comment there says the hosted project's Data API
must also be turned off in the Supabase dashboard. That setting is not
something this repo can prove about a hosted project.

The API handlers still call `@supabase/supabase-js` `.from()` and `.rpc()`.
Those calls are the Data API (PostgREST) with the caller's JWT. Turning the
hosted Data API off would stop the handlers as well as any direct browser
access. What the code enforces is narrower and concrete: no Supabase client
in the browser, and no service-role key in `app/` or `lib/`.

Song search is the one place a filter string is built by hand. Values go
through `escapePostgrestFilterValue` in `lib/api/postgrest.ts` before they
are quoted into an `ilike` filter.

## Where the other notes live

- HTTPS, HSTS, CSP, the git secret scan, and Dependabot:
  [`infrastructure-security.md`](infrastructure-security.md)
- The Phase 1 OWASP Top 10 review, with its date and scope:
  [`owasp-top-10-review.md`](owasp-top-10-review.md)
- Environment split and the variable names each environment must set:
  [`staging-environment.md`](staging-environment.md)
- Google OAuth client and the R2 bucket:
  [`google-oauth-r2-provisioning.md`](google-oauth-r2-provisioning.md)
- Schema files and how to apply them:
  [`../supabase/README.md`](../supabase/README.md)
- Load-test harness and the unfilled results table:
  [`performance-testing.md`](performance-testing.md)
