import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { InvitationStatus } from "@/types/domain";

// An invitation in one of these statuses is what grants a guest scoped read
// access to their week (PRD Flow 6 5a/5b): denied/withdrawn/expired grant
// nothing.
export const GUEST_ACCESS_STATUSES: InvitationStatus[] = ["pending", "accepted"];

export type GuestAccessResult = { allowed: boolean; dbError: boolean };

// Checks whether a guest (ctx.role === "guest") has a live invitation for a
// given service week (#72). Awaited directly rather than `.maybeSingle()`:
// a re-invited guest legitimately has several invitation rows for the same
// week, and `.maybeSingle()` errors on >1 row. Never throws.
export async function guestHasWeekAccess(
  supabase: SupabaseClient<Database>,
  serviceWeekId: string,
  userId: string,
): Promise<GuestAccessResult> {
  const { data, error } = await supabase
    .from("invitations")
    .select("id")
    .eq("service_week_id", serviceWeekId)
    .eq("user_id", userId)
    .in("status", GUEST_ACCESS_STATUSES)
    .limit(1);

  if (error) {
    return { allowed: false, dbError: true };
  }

  return { allowed: (data ?? []).length > 0, dbError: false };
}
