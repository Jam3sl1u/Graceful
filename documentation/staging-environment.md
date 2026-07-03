# Staging Environment

## 1. Purpose

Staging exists so Phase 1 changes can be validated end-to-end — against a real
database, real (test-mode) third-party services, and a real Vercel deployment —
before anything reaches production. It is the environment Playwright E2E tests
run against (PRD §26.2) and it is the required gate before a production deploy:
production deployments require staging to have deployed and passed its smoke
tests first (PRD §26.5 Production deploy gate, tracked separately as issue
#83). Environment isolation itself — development / staging / production, each
with its own credentials and no shared production secrets — is a hard MVP
security requirement (PRD §25.7 Environment isolation, PRD §26.5 CI/CD
Pipeline).

## 2. Environments overview

| Environment | Purpose | Host | Branch | Supabase project | API-key mode |
| --- | --- | --- | --- | --- | --- |
| Development | Local iteration on a developer's machine | `localhost` | any local/feature branch | Local or a personal dev Supabase project | Test/dev keys, developer-owned |
| Staging | Pre-production validation; target for Playwright E2E and the production deploy gate | Vercel Preview/staging deployment URL | `main` (auto-deploys on every merge) | Dedicated staging Supabase project (separate from production, identical schema) | Test/sandbox keys for every third-party service where available |
| Production | Live app used by real church groups | Vercel production deployment URL | set up later — same pattern (issue out of scope here) | set up later — same pattern (issue out of scope here) | set up later — same pattern (issue out of scope here) |

## 3. Vercel setup

Steps for the human operator provisioning staging in Vercel:

1. Connect the repository to a Vercel project (if not already connected).
2. Confirm the project's Git integration auto-deploys on push/merge to `main`.
   This is what makes `main` the staging deploy trigger — there is no GitHub
   Actions deploy job, and `.github/workflows/ci.yml` should NOT be modified
   to add one; Vercel's Git integration owns deploys entirely.
3. Production, when it is set up later, will map to a promotion step, git
   tags, or a dedicated `production` branch — that mapping is intentionally
   **not** specified here; it's out of scope for this issue.
4. **Environment variable convention (read this before adding any variable in
   the Vercel dashboard):** use Vercel's native per-Environment scoping
   (Production / Preview / Development), not name-prefixing. Every variable
   keeps the exact same name across all three Vercel environments (e.g.
   `NEXT_PUBLIC_SUPABASE_URL` is `NEXT_PUBLIC_SUPABASE_URL` in every
   environment) — only the *value* differs per environment. Staging values go
   under Vercel's "Preview" environment (since staging deploys from `main`
   via the standard Git integration flow), and production values will later
   go under "Production". Do **not** create prefixed variants like
   `STAGING_SUPABASE_URL` — the application code reads the plain variable
   names shown in `.env.example` (e.g. `NEXT_PUBLIC_SUPABASE_URL`,
   `CLERK_SECRET_KEY`), so a prefixed name would silently be `undefined` at
   runtime. This is the one unambiguous convention for this repo; do not
   introduce a second one later.

The table below mirrors the section groupings in `.env.example` and states
which variables need a value that is distinct to staging (never reused from
production) versus which may be shared across environments.

| `.env.example` section | Variables | Staging value |
| --- | --- | --- |
| App | `NEXT_PUBLIC_APP_URL` | Distinct — the staging deployment's own URL |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Distinct — staging Supabase project (see §5) |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | Distinct — Clerk test instance/test mode keys (see §4) |
| Pingram | `PINGRAM_API_KEY`, `PINGRAM_WEBHOOK_SECRET` | Distinct — Pingram test environment keys (see §4) |
| Resend | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Distinct — Resend test/sandbox key (see §4) |
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` | Distinct — `GOOGLE_REDIRECT_URI` must point at the staging host; use a dedicated OAuth client and encryption key for staging |
| Cloudflare R2 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT` | Distinct — separate staging R2 bucket and credentials (PRD §25.7) |
| Upstash Redis | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Distinct — dedicated staging Redis instance |
| Upstash QStash | `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Distinct — dedicated staging QStash credentials |
| Modal | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_WEBHOOK_SECRET` | Distinct — dedicated staging Modal token/webhook secret |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Shared — metadata-only lookup, no user data at risk; a single Spotify app's credentials may be reused across environments |

## 4. Test / sandbox keys

- **Clerk** — use a Clerk test instance for staging (Clerk supports separate
  dev/test/production instances with distinct publishable/secret keys). Never
  point staging at the production Clerk instance.
- **Pingram** — use Pingram's test environment/test API key for staging if the
  account offers one. If no distinct test tier is confirmed available, use a
  dedicated staging key on the same account — never the production key.
- **Resend** — use a Resend test API key or a sandbox/test sending domain for
  staging if available. If no sandbox tier is confirmed available, use a
  dedicated staging key on the same account — never the production key.

General rule: use test mode if the provider offers it, otherwise a separate,
dedicated staging key. Production credentials are never used in staging (PRD
§25.7).

## 5. Supabase

Staging gets its own, separate Supabase project — never the production
project. The schema must stay identical to production; the source of truth
for that schema is the migration files under `supabase/migrations/` (currently
empty scaffolding — see `supabase/README.md`). As those migrations are
authored, they are applied to the staging project first, and only promoted to
production after they succeed on staging (PRD §26.5 Migration safety). The
staging project's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
and `SUPABASE_SERVICE_ROLE_KEY` are set as the staging (Preview) values in
Vercel per §3 above and are never committed to this repo.

## 6. Verification checklist

- [ ] A staging Supabase project exists and is distinct from the production
      Supabase project (separate project ID, separate database).
- [ ] Staging is configured to use test/sandbox keys for Clerk, Pingram, and
      Resend (or dedicated staging-only keys where no sandbox tier exists) —
      not production credentials.
- [ ] Pushing/merging to `main` triggers an automatic Vercel deployment to the
      staging environment (verified via a Vercel deployment log entry).
- [ ] This document exists at `documentation/staging-environment.md` and is
      linked from `README.md`.
