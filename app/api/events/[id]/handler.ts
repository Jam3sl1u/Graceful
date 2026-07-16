import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { updateEventSchema, validateEventTiming } from "@/schemas/events";
import { toEventResponse } from "../handler";
import {
  syncEventToAttendees,
  unsyncEventFromAttendees,
  toGoogleEventId,
} from "@/lib/google-calendar/sync";

// PUT /api/events/:id — set_leader/admin only. Re-enforces BR-10 whenever
// startTime and/or endTime change.
export async function updateEvent(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = updateEventSchema.safeParse(body);
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

    const { data: existing, error: existingError } = await supabase
      .from("events")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (existingError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!existing) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    if (parsed.startTime !== undefined || parsed.endTime !== undefined) {
      const { data: week, error: weekError } = await supabase
        .from("service_weeks")
        .select("service_date")
        .eq("id", existing.service_week_id)
        .eq("church_group_id", ctx.churchGroupId)
        .maybeSingle();

      if (weekError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
      if (!week) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }

      const effectiveStart = parsed.startTime ?? existing.start_time;
      const effectiveEnd = parsed.endTime ?? existing.end_time;
      const timingError = validateEventTiming(week.service_date, effectiveStart, effectiveEnd);
      if (timingError) {
        return fail(timingError, ErrorCode.VALIDATION_FAILED, 422);
      }
    }

    const patch: Database["public"]["Tables"]["events"]["Update"] = {};
    if (parsed.type !== undefined) patch.type = parsed.type;
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.location !== undefined) patch.location = parsed.location;
    if (parsed.startTime !== undefined) patch.start_time = parsed.startTime;
    if (parsed.endTime !== undefined) patch.end_time = parsed.endTime;
    if (parsed.notes !== undefined) patch.notes = parsed.notes;

    const { data, error } = await supabase
      .from("events")
      .update(patch)
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("*")
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    // Legacy row with no mapping yet — backfill so update/delete/attendee
    // sync always have a google_calendar_event_id going forward (#62).
    let googleCalendarEventId = data.google_calendar_event_id;
    if (!googleCalendarEventId) {
      googleCalendarEventId = toGoogleEventId(data.id);
      try {
        await supabase
          .from("events")
          .update({ google_calendar_event_id: googleCalendarEventId })
          .eq("id", id)
          .eq("church_group_id", ctx.churchGroupId);
      } catch {
        // best-effort backfill; sync below still uses the computed id
      }
    }

    // Best-effort push to every assigned attendee's calendar. Never blocks
    // the update response on a sync failure (#62 graceful degradation).
    try {
      await syncEventToAttendees(supabase, data.id, {
        googleEventId: googleCalendarEventId,
        name: data.name,
        location: data.location,
        notes: data.notes,
        startTime: data.start_time,
        endTime: data.end_time,
      });
    } catch {
      // never block the update on sync failure
    }

    return ok({ event: toEventResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// DELETE /api/events/:id — set_leader/admin only, hard delete. Child
// event_attendees rows are removed via DB-level cascade, not here.
export async function deleteEvent(
  req: NextRequest,
  id: string,
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

    // Capture the Google Calendar mapping BEFORE deleting — the DB delete
    // cascades event_attendees, and get_event_sync_targets (called inside
    // unsyncEventFromAttendees) joins against that table, so the sync-target
    // list must be read while the row (and its attendees) still exist (#62).
    const { data: existing, error: existingError } = await supabase
      .from("events")
      .select("google_calendar_event_id")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (existingError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    if (existing?.google_calendar_event_id) {
      try {
        await unsyncEventFromAttendees(supabase, id, existing.google_calendar_event_id);
      } catch {
        // never block the delete on sync failure
      }
    }

    const { data, error } = await supabase
      .from("events")
      .delete()
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
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
