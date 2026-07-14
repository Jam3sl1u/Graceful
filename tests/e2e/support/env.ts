/**
 * Shared env-var gating for the staging-authenticated E2E suite (issue #52:
 * invitation-accept/deny/reminder + conflict-detection specs).
 *
 * These tests exercise a real browser session against a real Clerk
 * test-mode instance (`@clerk/testing`, OQ1) and seed/assert against a real
 * (staging) Supabase project via a service-role client (OQ4) — very
 * different from tests/e2e/health.spec.ts, which needs no secrets at all.
 * The required secrets are only present in CI when staging (#13) is
 * provisioned, and are typically absent for a local `bun run test:e2e` —
 * so every test in the affected spec files calls `test.skip(!e2eAuthEnabled, ...)`
 * rather than failing when they're absent. Mirrors the gating pattern in
 * tests/integration/rls/setup.ts (`rlsTestsEnabled`).
 *
 * Required env vars (set as GitHub Actions secrets for the `e2e` CI job,
 * documentation/staging-environment.md):
 *   STAGING_APP_URL                 — staging deployment base URL (Playwright baseURL)
 *   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — Clerk test-mode instance (same name the app itself reads)
 *   CLERK_SECRET_KEY                — Clerk test-mode instance secret key
 *   E2E_ADMIN_EMAIL                 — seeded staging Clerk test user (admin persona)
 *   E2E_MEMBER_EMAIL                — seeded staging Clerk test user (member persona)
 *   E2E_SUPABASE_URL                — staging Supabase project URL (seed/teardown only)
 *   E2E_SUPABASE_SERVICE_ROLE_KEY   — staging Supabase service-role key (seed/teardown only)
 *
 * tests/e2e/invitation-reminder.spec.ts additionally requires CRON_SECRET.
 */

const REQUIRED_VARS = [
  "STAGING_APP_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "E2E_ADMIN_EMAIL",
  "E2E_MEMBER_EMAIL",
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
] as const;

/** Checks REQUIRED_VARS plus any spec-specific extras (e.g. CRON_SECRET). */
export function checkEnv(extra: readonly string[] = []): boolean {
  return [...REQUIRED_VARS, ...extra].every((v) => Boolean(process.env[v]));
}

/** True only when every var in REQUIRED_VARS is set. Computed once at import time. */
export const e2eAuthEnabled = checkEnv();

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var for E2E tests: ${name}`);
  return val;
}
