import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { updateServiceWeekSchema } from "@/schemas/service-weeks";
import { guestHasWeekAccess } from "@/lib/invitations/guest-access";
import { toServiceWeekResponse } from "../handler";

// GET /api/service-weeks/:id — any authenticated member. Guests must have a
// matching invitation for this week, or the row is treated as not found (do
// NOT leak existence via 403).
export async function getServiceWeek(
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

    const { data, error } = await supabase
      .from("service_weeks")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    if (ctx.role === "guest") {
      const access = await guestHasWeekAccess(supabase, id, ctx.userId);
      if (access.dbError) return fail("Internal error", ErrorCode.INTERNAL, 500);
      if (!access.allowed) return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ serviceWeek: toServiceWeekResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// PUT /api/service-weeks/:id — set_leader/admin only.
export async function updateServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = updateServiceWeekSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const patch: Database["public"]["Tables"]["service_weeks"]["Update"] = {};
    if (parsed.serviceDate !== undefined) patch.service_date = parsed.serviceDate;
    if (parsed.title !== undefined) patch.title = parsed.title;
    if (parsed.sermonTopic !== undefined) patch.sermon_topic = parsed.sermonTopic;
    if (parsed.sermonScripture !== undefined) patch.sermon_scripture = parsed.sermonScripture;
    if (parsed.speakerName !== undefined) patch.speaker_name = parsed.speakerName;

    const { data, error } = await supabase
      .from("service_weeks")
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

    return ok({ serviceWeek: toServiceWeekResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

const CANCEL_INSTEAD_HINT =
  "Use POST /api/service-weeks/:id/cancel instead — it preserves scheduling history.";

// DELETE /api/service-weeks/:id — admin only, true hard delete (BR-16). Only
// allowed when service_date is in the future AND zero accepted invitations
// exist — this is reserved for pre-invite mistakes, since service-week data
// feeds AI Pipelines 2 and 3. All other cases return 409 pointing at /cancel
// (#39) instead. Child rows (setlists, events, invitations, ...) are removed
// via DB-level `on delete cascade`, not deleted individually here.
export async function deleteServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: week, error: weekError } = await supabase
      .from("service_weeks")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (weekError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!week) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (week.service_date <= today) {
      return fail(
        `Service week's date has already passed. ${CANCEL_INSTEAD_HINT}`,
        ErrorCode.CONFLICT,
        409,
      );
    }

    const { data: acceptedInvitations, error: invitationsError } = await supabase
      .from("invitations")
      .select("id")
      .eq("service_week_id", id)
      .eq("status", "accepted");

    if (invitationsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if ((acceptedInvitations ?? []).length > 0) {
      return fail(
        `Service week has accepted invitations. ${CANCEL_INSTEAD_HINT}`,
        ErrorCode.CONFLICT,
        409,
      );
    }

    const { error: deleteError } = await supabase
      .from("service_weeks")
      .delete()
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId);

    if (deleteError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ deleted: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// Shared cancel/reactivate implementation (BR-17, #39). Pure status-flag
// flips on service_weeks.is_cancelled plus notification fan-out to
// pending/accepted invitees. Child rows (setlist, events, invitations,
// conflicts) are NEVER modified here.
async function setServiceWeekCancelled(
  req: NextRequest,
  id: string,
  lookup: UserLookup | undefined,
  isCancelled: boolean,
  notificationType: "service_week_cancelled" | "service_week_reactivated",
  notificationTitle: string,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("service_weeks")
      .update({ is_cancelled: isCancelled })
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

    const { data: invitations, error: invitationsError } = await supabase
      .from("invitations")
      .select("user_id")
      .eq("service_week_id", id)
      .in("status", ["pending", "accepted"]);

    if (invitationsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const recipientIds = [...new Set((invitations ?? []).map((i) => i.user_id))];

    if (recipientIds.length > 0) {
      const notificationInsertPayload = recipientIds.map((userId) => ({
        church_group_id: ctx.churchGroupId,
        user_id: userId,
        type: notificationType,
        title: notificationTitle,
        body: null,
        link_entity_type: "service_week",
        link_entity_id: id,
      })) as unknown as Database["public"]["Tables"]["notifications"]["Insert"][];

      const { error: notificationsError } = await supabase
        .from("notifications")
        .insert(notificationInsertPayload);

      if (notificationsError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
    }

    // TODO(Phase 2 chat): archive chat room placeholder for this week — no
    // chat table exists yet.

    // TODO(#62 GCal sync): remove synced Google Calendar events for this
    // week's events.

    return ok({ serviceWeek: toServiceWeekResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/service-weeks/:id/cancel — admin only (BR-17, #39). Flips
// is_cancelled to true and notifies pending/accepted invitees. Cancelling an
// already-cancelled week is allowed and still re-notifies (no 409 for the
// already-in-state case).
export async function cancelServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  return setServiceWeekCancelled(
    req,
    id,
    lookup,
    true,
    "service_week_cancelled",
    "Service week cancelled",
  );
}

// POST /api/service-weeks/:id/reactivate — admin only (BR-17, #39). Flips
// is_cancelled to false and re-notifies pending/accepted invitees.
// Reactivating an already-active week is allowed and still re-notifies (no
// 409 for the already-in-state case).
export async function reactivateServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  return setServiceWeekCancelled(
    req,
    id,
    lookup,
    false,
    "service_week_reactivated",
    "Service week reactivated",
  );
}
