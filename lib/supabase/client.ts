import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Returns an RLS-scoped Supabase client for the given Clerk-issued JWT.
// Uses the anon key only — SUPABASE_SERVICE_ROLE_KEY is never used in
// user-callable code (PRD §19.3 / issue #23).
export function getSupabaseClient(jwt: string): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing required env vars: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }

  return createClient<Database>(url, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
  });
}

// Returns a Supabase client with no Authorization header, running as the
// Postgres `anon` role. Used only for the no-session invitation-accept path
// (#41), which authenticates via response_token inside the
// accept_invitation SECURITY DEFINER RPC rather than a Clerk JWT.
export function getAnonSupabaseClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing required env vars: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }

  return createClient<Database>(url, anonKey);
}
