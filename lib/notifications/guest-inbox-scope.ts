import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export type GuestInboxScope = { linkEntityIds: string[]; dbError: boolean };

// Resolves the set of notification `link_entity_id`s a guest is allowed to see
// in their inbox (#71). A guest sees notifications linked to one of their own
// invitation rows, one of the service weeks those invitations point at, or a
// setlist belonging to one of those weeks.
//
// NOTE: this deliberately uses ALL invitation rows regardless of status — it is
// NOT the `pending`/`accepted` gate that `guestHasWeekAccess`
// (GUEST_ACCESS_STATUSES) applies to *content* reads. Using live statuses here
// would hide the `invitation_withdrawn` notification at the exact moment it is
// written (the withdraw path sets status = 'withdrawn' immediately before
// inserting the row), so the guest could never learn they were withdrawn.
//
// The three id lists can be concatenated into a single `.in("link_entity_id",
// ...)` filter because invitation ids, service-week ids and setlist ids are all
// UUID primary keys and therefore globally unique — there is no chance of an id
// from one table colliding with an id from another, so no per-`link_entity_type`
// `.or()` grouping is needed. Never throws; returns `dbError: true` instead.
export async function getGuestInboxLinkEntityIds(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<GuestInboxScope> {
  const { data: invitationRows, error: invitationsError } = await supabase
    .from("invitations")
    .select("id, service_week_id")
    .eq("user_id", userId);

  if (invitationsError) {
    return { linkEntityIds: [], dbError: true };
  }

  const invitations = invitationRows ?? [];
  const invitationIds = invitations.map((row) => row.id);
  const weekIds = [...new Set(invitations.map((row) => row.service_week_id))];

  if (weekIds.length === 0) {
    return { linkEntityIds: [], dbError: false };
  }

  const { data: setlistRows, error: setlistsError } = await supabase
    .from("setlists")
    .select("id")
    .in("service_week_id", weekIds);

  if (setlistsError) {
    return { linkEntityIds: [], dbError: true };
  }

  const setlistIds = (setlistRows ?? []).map((row) => row.id);

  return {
    linkEntityIds: [...new Set([...invitationIds, ...weekIds, ...setlistIds])],
    dbError: false,
  };
}
