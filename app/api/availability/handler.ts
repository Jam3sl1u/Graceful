import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import {
  availabilityDateParamSchema,
  getAvailabilityQuerySchema,
  setAvailabilitySchema,
  type SetAvailabilityEntry,
} from "@/schemas/availability";
import { recordAvailabilityConflict } from "@/lib/scheduling/conflict-detection";

export type AvailabilityEntry = {
  userId: string;
  date: string; // YYYY-MM-DD
  isAvailable: boolean;
  note: string | null;
};

// Guards against a member blocking years of availability by accident (e.g. a
// startDate/endDate typo). 366 covers a full leap year.
const MAX_EXPANDED_DATES = 366;

// GET /api/availability — the caller's own availability, or (for
// admin/set_leader only) another member's via ?user_id=. RLS already scopes
// SELECT to the caller's church group; requireRole is defense in depth so a
// plain member reading someone else's availability gets 403 FORBIDDEN.
export async function getAvailability(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const parsedResult = getAvailabilityQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { user_id } = parsedResult.data;

    let targetUserId = ctx.userId;
    if (user_id && user_id !== ctx.userId) {
      requireRole(ctx, ["admin", "set_leader"]);
      targetUserId = user_id;
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("availability")
      .select("user_id, date, is_available, note")
      .eq("user_id", targetUserId)
      .order("date", { ascending: true });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const availability: AvailabilityEntry[] = (data ?? []).map((row) => ({
      userId: row.user_id,
      date: row.date,
      isAvailable: row.is_available,
      note: row.note,
    }));

    return ok({ availability });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// Expands one validated entry into its concrete YYYY-MM-DD date strings
// (single date, or every date in an inclusive startDate..endDate range).
function expandEntryDates(entry: SetAvailabilityEntry): string[] {
  if (entry.date) {
    return [entry.date];
  }

  const dates: string[] = [];
  const cursor = new Date(`${entry.startDate}T00:00:00Z`);
  const end = new Date(`${entry.endDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// PUT /api/availability — sets the caller's OWN availability for one or more
// dates (single dates and/or inclusive date ranges, expanded server-side).
// Scope is always the caller; leaders/admins setting another member's
// availability via PUT is not in the AC (#34).
export async function setAvailability(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const body = await req.json().catch(() => null);
    const parsedResult = setAvailabilitySchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { entries } = parsedResult.data;

    // Expand every entry into concrete dates, deduping by date (last-entry-
    // wins) — a single Postgres upsert can't touch the same conflict target
    // (user_id, date) twice in one statement.
    const byDate = new Map<string, { isAvailable: boolean; note: string | null }>();
    let totalExpanded = 0;
    for (const entry of entries) {
      const dates = expandEntryDates(entry);
      totalExpanded += dates.length;
      if (totalExpanded > MAX_EXPANDED_DATES) {
        return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
      }
      for (const date of dates) {
        byDate.set(date, { isAvailable: entry.isAvailable ?? true, note: entry.note });
      }
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // The hand-rolled Insert type in lib/supabase/types.ts marks `created_at`
    // as required even though the DB column has a `now()` default. Cast
    // narrowly here rather than widening the shared type (mirrors
    // app/api/profile/handler.ts).
    const rows = Array.from(byDate.entries()).map(([date, { isAvailable, note }]) => ({
      user_id: ctx.userId,
      church_group_id: ctx.churchGroupId,
      date,
      is_available: isAvailable,
      note,
    })) as unknown as Database["public"]["Tables"]["availability"]["Insert"][];

    const { data, error } = await supabase
      .from("availability")
      .upsert(rows, { onConflict: "user_id,date" })
      .select("user_id, date, is_available, note");

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    // BR-15 (#46): fire conflict detection for every date the member just
    // marked unavailable (marking available is never a conflict). The
    // upsert above already wrote the is_available: false row (and its
    // note) for each such date, so the RPC can read that note for the
    // notification body. Mirrors deleteAvailability's use of the same
    // shared trigger point; errors propagate via the existing catch below.
    let conflictTriggered = false;
    for (const [date, { isAvailable }] of byDate.entries()) {
      if (isAvailable === false) {
        const triggered = await recordAvailabilityConflict(supabase, date, "marked_unavailable");
        if (triggered) conflictTriggered = true;
      }
    }

    const availability: AvailabilityEntry[] = (data ?? []).map((row) => ({
      userId: row.user_id,
      date: row.date,
      isAvailable: row.is_available,
      note: row.note,
    }));

    return ok({ availability, conflictTriggered });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

export type DeleteAvailabilityResult = {
  date: string;
  conflictTriggered: boolean;
};

// DELETE /api/availability/:date — clears the caller's OWN availability
// declaration for a date, reverting it to unset/unknown. This is NOT the
// same as explicitly marking available (is_available: true): unset is the
// absence of a row, distinguishable from both is_available: true and
// is_available: false. Scope is always the caller (mirrors setAvailability
// — no admin-deletes-for-another-member path exists here).
//
// BR-15 (#35, PRD §8): a quiet deletion of an availability declaration is
// functionally identical to the member becoming unavailable. If the caller
// has an accepted invitation for a service on this date, deletion must
// trigger the same conflict-detection flow as explicitly marking
// unavailable (#46) — never a silent no-op. recordAvailabilityConflict is
// the shared trigger point both paths call.
export async function deleteAvailability(
  req: NextRequest,
  date: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const parsedDate = availabilityDateParamSchema.safeParse(date);
    if (!parsedDate.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // Clearing an already-unset date is a no-op delete (0 rows affected),
    // not an error — DELETE is idempotent.
    const { error: deleteError } = await supabase
      .from("availability")
      .delete()
      .eq("user_id", ctx.userId)
      .eq("date", parsedDate.data);

    if (deleteError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const conflictTriggered = await recordAvailabilityConflict(
      supabase,
      parsedDate.data,
      "availability_deleted",
    );

    return ok<DeleteAvailabilityResult>({ date: parsedDate.data, conflictTriggered });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
