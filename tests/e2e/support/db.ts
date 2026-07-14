/**
 * Service-role Supabase client factory for the staging E2E suite (issue #52).
 *
 * Mirrors tests/integration/rls/client.ts's getServiceClient: bypasses RLS,
 * used only for seed/assert/cleanup against the staging project — never to
 * exercise the app's own authorization. Exercising authorization is what the
 * Clerk-authenticated browser session (tests/e2e/support/auth.ts) is for.
 *
 * Safe to import from tests/e2e/ (unlike app/ and lib/): the service-role
 * guard (scripts/check-service-role.mjs) only scans app/ and lib/.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getE2EServiceClient(): SupabaseClient<any> {
  return createClient(
    requireEnv("E2E_SUPABASE_URL"),
    requireEnv("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}
