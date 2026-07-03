/**
 * Supabase client factory for RLS integration tests.
 *
 * Two kinds of clients are needed:
 *  1. Service-role client — bypasses RLS; used for seeding and cleanup.
 *  2. User JWT client    — subject to RLS; used for assertion queries.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mintJwt, type TestClaims } from "./jwt";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var for RLS tests: ${name}`);
  return val;
}

/** Service-role client — bypasses RLS. Use only for seed/teardown. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getServiceClient(): SupabaseClient<any> {
  return createClient(
    requireEnv("SUPABASE_TEST_URL"),
    requireEnv("SUPABASE_TEST_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

/** Anon-key client authenticated with a minted user JWT — subject to RLS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUserClient(claims: TestClaims): SupabaseClient<any> {
  const token = mintJwt(claims);
  return createClient(
    requireEnv("SUPABASE_TEST_URL"),
    requireEnv("SUPABASE_TEST_ANON_KEY"),
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
}
