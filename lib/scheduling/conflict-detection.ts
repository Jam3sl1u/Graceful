import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ApiException, ErrorCode } from "@/lib/api/errors";

// BR-15 (PRD §8): a member losing an accepted invitation's availability —
// whether by explicitly marking unavailable or by quietly deleting the
// declaration — must trigger conflict detection the same way. Callers pass
// a reason so each trigger path stays distinguishable in conflicts.trigger_reason.
export type ConflictTriggerReason = "availability_deleted" | "marked_unavailable";

// Records a conflict for the caller's OWN user + church group (both derived
// server-side from the JWT inside the record_availability_conflict RPC) for
// every accepted invitation to a service on `date`. Returns true iff at
// least one conflict was recorded. `supabase` MUST be the RLS-scoped client
// for the acting user (getSupabaseClient(jwt)) — the RPC runs SECURITY
// DEFINER specifically because conflicts has no member-level INSERT policy.
// Throws ApiException(INTERNAL, 500) on DB error; never swallows.
export async function recordAvailabilityConflict(
  supabase: SupabaseClient<Database>,
  date: string,
  reason: ConflictTriggerReason,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("record_availability_conflict", {
    p_date: date,
    p_trigger_reason: reason,
  });

  if (error) {
    throw new ApiException("Internal error", ErrorCode.INTERNAL, 500);
  }

  return Boolean(data);
}
