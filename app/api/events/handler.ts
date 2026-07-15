import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import type { EventType } from "@/types/domain";
import { createEventSchema, validateEventTiming } from "@/schemas/events";

type EventsRow = Database["public"]["Tables"]["events"]["Row"];

export type EventResponse = {
  id: string;
  serviceWeekId: string;
  type: EventType;
  name: string;
  location: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
};

export function toEventResponse(row: EventsRow): EventResponse {
  return {
    id: row.id,
    serviceWeekId: row.service_week_id,
    type: row.type,
    name: row.name,
    location: row.location,
    startTime: row.start_time,
    endTime: row.end_time,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// GET /api/events — any authenticated role. Admins see every event in the
// group; all non-admins (set_leader/member/guest) are scoped to events on
// service weeks they have an invitation for.
export async function listEvents(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    if (ctx.role === "admin") {
      const { data, error } = await supabase
        .from("events")
        .select("*")
        .eq("church_group_id", ctx.churchGroupId)
        .order("start_time", { ascending: true });

      if (error) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      return ok({ events: (data ?? []).map(toEventResponse) });
    }

    const { data: invitations, error: invitationsError } = await supabase
      .from("invitations")
      .select("service_week_id")
      .eq("user_id", ctx.userId);

    if (invitationsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const serviceWeekIds = [...new Set((invitations ?? []).map((i) => i.service_week_id))];
    if (serviceWeekIds.length === 0) {
      return ok({ events: [] });
    }

    const { data, error } = await supabase
      .from("events")
      .select("*")
      .eq("church_group_id", ctx.churchGroupId)
      .in("service_week_id", serviceWeekIds)
      .order("start_time", { ascending: true });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ events: (data ?? []).map(toEventResponse) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/events — set_leader/admin only. Enforces BR-10 (end after start,
// both within 72h of the parent service week's service_date).
export async function createEvent(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = createEventSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: week, error: weekError } = await supabase
      .from("service_weeks")
      .select("service_date")
      .eq("id", parsed.serviceWeekId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (weekError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!week) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    // BR-10: a syntactically valid body can still violate the time rule —
    // that is a 422, not a 400.
    const timingError = validateEventTiming(week.service_date, parsed.startTime, parsed.endTime);
    if (timingError) {
      return fail(timingError, ErrorCode.VALIDATION_FAILED, 422);
    }

    // The hand-rolled Insert type in lib/supabase/types.ts marks some
    // DB-defaulted columns as required even though they have defaults —
    // cast narrowly here rather than widening the shared type (mirrors
    // app/api/service-weeks/handler.ts createServiceWeek).
    const eventInsertPayload = {
      church_group_id: ctx.churchGroupId,
      service_week_id: parsed.serviceWeekId,
      type: parsed.type,
      name: parsed.name,
      location: parsed.location ?? null,
      start_time: parsed.startTime,
      end_time: parsed.endTime,
      notes: parsed.notes ?? null,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["events"]["Insert"];

    const { data: event, error: eventError } = await supabase
      .from("events")
      .insert(eventInsertPayload)
      .select("*")
      .maybeSingle();

    if (eventError || !event) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ event: toEventResponse(event) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
