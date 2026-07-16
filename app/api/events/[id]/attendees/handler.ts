import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { assignAttendeeSchema } from "@/schemas/events";
import { syncEventToUser, unsyncEventFromUser } from "@/lib/google-calendar/sync";

type EventAttendeesRow = Database["public"]["Tables"]["event_attendees"]["Row"];

export type AttendeeResponse = {
  id: string;
  eventId: string;
  userId: string;
  createdAt: string;
};

export function toAttendeeResponse(row: EventAttendeesRow): AttendeeResponse {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

// POST /api/events/:id/attendees — set_leader/admin only. Assigns a
// confirmed member (accepted invitation for the event's service week) as an
// attendee of the event.
export async function assignAttendee(
  req: NextRequest,
  eventId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = assignAttendeeSchema.safeParse(body);
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

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("service_week_id, google_calendar_event_id, name, location, notes, start_time, end_time")
      .eq("id", eventId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (eventError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!event) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const { data: invitation, error: invitationError } = await supabase
      .from("invitations")
      .select("id")
      .eq("church_group_id", ctx.churchGroupId)
      .eq("service_week_id", event.service_week_id)
      .eq("user_id", parsed.userId)
      .eq("status", "accepted")
      .maybeSingle();

    if (invitationError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!invitation) {
      return fail(
        "Member is not confirmed for this event",
        ErrorCode.VALIDATION_FAILED,
        422,
      );
    }

    const { data: existingAttendee, error: existingAttendeeError } = await supabase
      .from("event_attendees")
      .select("id")
      .eq("event_id", eventId)
      .eq("user_id", parsed.userId)
      .maybeSingle();

    if (existingAttendeeError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (existingAttendee) {
      return fail(
        "Member is already assigned to this event",
        ErrorCode.CONFLICT,
        409,
      );
    }

    const { data: attendee, error: attendeeError } = await supabase
      .from("event_attendees")
      .insert({ event_id: eventId, user_id: parsed.userId })
      .select("*")
      .maybeSingle();

    if (attendeeError || !attendee) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    // Best-effort push onto the newly-assigned member's calendar. Never
    // blocks the assignment on a sync failure (#62 graceful degradation).
    if (event.google_calendar_event_id) {
      try {
        await syncEventToUser(supabase, eventId, parsed.userId, {
          googleEventId: event.google_calendar_event_id,
          name: event.name,
          location: event.location,
          notes: event.notes,
          startTime: event.start_time,
          endTime: event.end_time,
        });
      } catch {
        // never block attendee assignment on sync failure
      }
    }

    return ok({ attendee: toAttendeeResponse(attendee) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// DELETE /api/events/:id/attendees/:userId — set_leader/admin only.
export async function removeAttendee(
  req: NextRequest,
  eventId: string,
  targetUserId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, google_calendar_event_id")
      .eq("id", eventId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (eventError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!event) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    // Capture + push the calendar removal BEFORE deleting the attendee row —
    // get_event_sync_targets (inside unsyncEventFromUser) joins on
    // event_attendees, so this member would no longer be a visible sync
    // target once the row below is gone (#62).
    if (event.google_calendar_event_id) {
      try {
        await unsyncEventFromUser(supabase, eventId, targetUserId, event.google_calendar_event_id);
      } catch {
        // never block removal on sync failure
      }
    }

    const { data, error } = await supabase
      .from("event_attendees")
      .delete()
      .eq("event_id", eventId)
      .eq("user_id", targetUserId)
      .select("id")
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ deleted: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
