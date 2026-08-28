import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { serviceWeeksOverviewQuerySchema } from "@/schemas/service-weeks";
import type { SetlistStatus } from "@/types/domain";

export type ServiceWeekOverviewEntry = {
  id: string;
  serviceDate: string; // service_weeks.service_date, YYYY-MM-DD
  title: string | null;
  isCancelled: boolean;
  setlistStatus: SetlistStatus | null; // null = no setlist row for this week
  confirmedCount: number; // numerator of the fill rate
  rosterSize: number; // denominator of the fill rate
  openConflictCount: number; // open (resolved_at IS NULL) conflicts for this week
};

export type ServiceWeeksOverviewResponse = {
  serviceWeeks: ServiceWeekOverviewEntry[];
};

// Supabase/PostgREST caps unbounded reads at 1000 rows by default, which
// would silently truncate (and understate) roster/conflict counts once a
// group accumulates enough invitation history. Page through with .range()
// so a large group-wide read is never silently cut off.
const PAGE_SIZE = 1000;

async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { data: rows, error: null };
    from += PAGE_SIZE;
  }
}

// GET /api/service-weeks/overview (#74) — one cross-week, group-wide read for
// the Admin Global Dashboard screen (PRD wireframe screen 8). Admin/set_leader
// only. All reads go through the caller's RLS-scoped Supabase client — no
// service-role client, no RPC, no migration.
export async function getServiceWeeksOverview(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const parsedResult = serviceWeeksOverviewQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { startDate, endDate, status } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // 1. Weeks
    let weeksQuery = supabase
      .from("service_weeks")
      .select("id, service_date, title, is_cancelled")
      .eq("church_group_id", ctx.churchGroupId);

    if (startDate) weeksQuery = weeksQuery.gte("service_date", startDate);
    if (endDate) weeksQuery = weeksQuery.lte("service_date", endDate);
    if (status === "active") weeksQuery = weeksQuery.eq("is_cancelled", false);
    else if (status === "cancelled") weeksQuery = weeksQuery.eq("is_cancelled", true);

    const { data: weekRows, error: weeksError } = await weeksQuery.order("service_date", {
      ascending: false,
    });

    if (weeksError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const weeks = weekRows ?? [];
    if (weeks.length === 0) {
      return ok<ServiceWeeksOverviewResponse>({ serviceWeeks: [] });
    }

    const weekIds = weeks.map((w) => w.id);

    // 2. Setlists
    const { data: setlistRows, error: setlistsError } = await supabase
      .from("setlists")
      .select("service_week_id, status")
      .eq("church_group_id", ctx.churchGroupId)
      .in("service_week_id", weekIds);

    if (setlistsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const setlistStatusByWeekId = new Map<string, SetlistStatus>();
    for (const row of setlistRows ?? []) {
      setlistStatusByWeekId.set(row.service_week_id, row.status);
    }

    // 3. Invitations — explicit columns only, never select("*") (response_token
    // / denial_reason must not leak; see listInvitations).
    const { data: invitationRows, error: invitationsError } = await fetchAllPages((from, to) =>
      supabase
        .from("invitations")
        .select("id, service_week_id, user_id, status, created_at")
        .eq("church_group_id", ctx.churchGroupId)
        .in("service_week_id", weekIds)
        .range(from, to),
    );

    if (invitationsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    // Latest invitation per (service_week_id, user_id): replace only when
    // strictly greater created_at (mirrors getCurrentInvitation in week-view.tsx).
    const latestByWeekAndUser = new Map<
      string,
      { status: string; created_at: string; service_week_id: string }
    >();
    for (const row of invitationRows ?? []) {
      const key = `${row.service_week_id}:${row.user_id}`;
      const existing = latestByWeekAndUser.get(key);
      if (!existing || row.created_at > existing.created_at) {
        latestByWeekAndUser.set(key, row);
      }
    }

    const rosterSizeByWeekId = new Map<string, number>();
    const confirmedCountByWeekId = new Map<string, number>();
    for (const latest of latestByWeekAndUser.values()) {
      if (latest.status !== "withdrawn") {
        rosterSizeByWeekId.set(
          latest.service_week_id,
          (rosterSizeByWeekId.get(latest.service_week_id) ?? 0) + 1,
        );
      }
      if (latest.status === "accepted") {
        confirmedCountByWeekId.set(
          latest.service_week_id,
          (confirmedCountByWeekId.get(latest.service_week_id) ?? 0) + 1,
        );
      }
    }

    // 4. Conflicts — scoped to the invitation ids already in hand (narrower
    // read than group-wide) and mapped to a week via the invitation rows
    // above; a conflict whose invitation belongs to a filtered-out week is
    // ignored.
    const invitationIds = (invitationRows ?? []).map((row) => row.id);
    let conflictRows: { id: string; invitation_id: string }[] = [];
    if (invitationIds.length > 0) {
      const { data, error: conflictsError } = await fetchAllPages((from, to) =>
        supabase
          .from("conflicts")
          .select("id, invitation_id")
          .eq("church_group_id", ctx.churchGroupId)
          .is("resolved_at", null)
          .in("invitation_id", invitationIds)
          .range(from, to),
      );

      if (conflictsError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
      conflictRows = data;
    }

    const invitationById = new Map((invitationRows ?? []).map((row) => [row.id, row]));
    const openConflictCountByWeekId = new Map<string, number>();
    for (const conflict of conflictRows) {
      const invitation = invitationById.get(conflict.invitation_id);
      if (!invitation) continue;
      openConflictCountByWeekId.set(
        invitation.service_week_id,
        (openConflictCountByWeekId.get(invitation.service_week_id) ?? 0) + 1,
      );
    }

    const serviceWeeks: ServiceWeekOverviewEntry[] = weeks.map((w) => ({
      id: w.id,
      serviceDate: w.service_date,
      title: w.title,
      isCancelled: w.is_cancelled,
      setlistStatus: setlistStatusByWeekId.get(w.id) ?? null,
      confirmedCount: confirmedCountByWeekId.get(w.id) ?? 0,
      rosterSize: rosterSizeByWeekId.get(w.id) ?? 0,
      openConflictCount: openConflictCountByWeekId.get(w.id) ?? 0,
    }));

    return ok<ServiceWeeksOverviewResponse>({ serviceWeeks });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
