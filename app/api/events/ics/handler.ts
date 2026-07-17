import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { generateIcs, icsResponse, type IcalEventInput } from "@/lib/ical/generate";

const serviceWeekIdSchema = z.string().uuid();

// GET /api/events/ics — any authenticated member, no role gate. Exports
// every one of the caller's *assigned* events (event_attendees, the #60
// attendee model) as a single .ics file, optionally narrowed to one service
// week via ?serviceWeekId=<uuid> (#63).
export async function exportEventsIcs(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const serviceWeekIdParam = req.nextUrl.searchParams.get("serviceWeekId");
    let serviceWeekId: string | null = null;
    if (serviceWeekIdParam !== null) {
      const parsedResult = serviceWeekIdSchema.safeParse(serviceWeekIdParam);
      if (!parsedResult.success) {
        return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
      }
      serviceWeekId = parsedResult.data;
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: attendeeRows, error: attendeeError } = await supabase
      .from("event_attendees")
      .select("event_id")
      .eq("user_id", ctx.userId);

    if (attendeeError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const eventIds = [...new Set((attendeeRows ?? []).map((r) => r.event_id))];
    if (eventIds.length === 0) {
      return fail("No events to export", ErrorCode.NOT_FOUND, 404);
    }

    let query = supabase
      .from("events")
      .select("id, name, location, notes, start_time, end_time")
      .in("id", eventIds);

    if (serviceWeekId) {
      query = query.eq("service_week_id", serviceWeekId);
    }

    const { data: events, error: eventsError } = await query.order("start_time", {
      ascending: true,
    });

    if (eventsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!events || events.length === 0) {
      // Covers both "no assigned events matched serviceWeekId" and the
      // (already-handled-above) zero-attendee-rows case.
      return fail("No events to export", ErrorCode.NOT_FOUND, 404);
    }

    const icalEvents: IcalEventInput[] = events.map((event) => ({
      uid: `${event.id}@graceful.app`,
      title: event.name,
      start: event.start_time,
      end: event.end_time,
      location: event.location,
      description: event.notes,
    }));

    const ics = generateIcs(icalEvents);
    return icsResponse(ics, "graceful-events.ics");
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
