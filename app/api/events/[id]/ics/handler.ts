import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { generateIcs, icsResponse, icsFilename, type IcalEventInput } from "@/lib/ical/generate";

// GET /api/events/:id/ics — any authenticated member, no role gate. Exports
// a single-VEVENT .ics file for one of the caller's *assigned* events
// (event_attendees, the #60 attendee model) — NOT the invitation-scoped
// list used by GET /api/events (#63).
export async function exportEventIcs(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // Verify the caller is an assigned attendee of this event before
    // fetching it — never leak an event the caller isn't assigned to.
    const { data: attendee, error: attendeeError } = await supabase
      .from("event_attendees")
      .select("id")
      .eq("event_id", id)
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (attendeeError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!attendee) {
      // Don't distinguish "exists but not yours" from "doesn't exist".
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, name, location, notes, start_time, end_time")
      .eq("id", id)
      .maybeSingle();

    if (eventError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!event) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const icalEvent: IcalEventInput = {
      uid: `${event.id}@graceful.app`,
      title: event.name,
      start: event.start_time,
      end: event.end_time,
      location: event.location,
      description: event.notes,
    };

    const ics = generateIcs([icalEvent]);
    return icsResponse(ics, icsFilename(event.name));
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
