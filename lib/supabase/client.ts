import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// TODO(Sprint 0 #7-14): build an RLS-scoped client using the caller's Clerk
// JWT (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Never use
// SUPABASE_SERVICE_ROLE_KEY here — that key belongs only in trusted
// migration/seed scripts, never in user-callable code (PRD §19.3).
export function getSupabaseClient(_jwt: string): SupabaseClient {
  throw new Error("getSupabaseClient not implemented — see Sprint 0 #7-14");
}
