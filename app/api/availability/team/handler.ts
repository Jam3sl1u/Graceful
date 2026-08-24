import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getTeamAvailabilityQuerySchema } from "@/schemas/availability";

export type TeamAvailabilityEntry = {
  date: string; // YYYY-MM-DD
  isAvailable: boolean;
  note: string | null;
};

export type TeamAvailabilityMember = {
  userId: string;
  entries: TeamAvailabilityEntry[];
};

// GET /api/availability/team — every member's availability for a date range,
// grouped by member (Set Leader/Admin only). RLS already scopes SELECT to the
// caller's church group; requireRole is the real gate here since RLS itself
// doesn't restrict by role.
export async function getTeamAvailability(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const parsedResult = getTeamAvailabilityQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { startDate, endDate } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("availability")
      .select("user_id, date, is_available, note")
      .eq("church_group_id", ctx.churchGroupId)
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const entriesByUserId = new Map<string, TeamAvailabilityEntry[]>();
    for (const row of data ?? []) {
      const entries = entriesByUserId.get(row.user_id) ?? [];
      entries.push({ date: row.date, isAvailable: row.is_available, note: row.note });
      entriesByUserId.set(row.user_id, entries);
    }

    const members: TeamAvailabilityMember[] = Array.from(entriesByUserId.entries()).map(
      ([userId, entries]) => ({ userId, entries }),
    );

    return ok({ startDate, endDate, members });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
