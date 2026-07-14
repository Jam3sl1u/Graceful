import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { writeAuditLog } from "@/lib/audit/write-audit-log";
import { resolveConflictSchema } from "@/schemas/conflicts";
import type { InvitationStatus, ResolutionType } from "@/types/domain";

export type OpenConflict = {
  id: string;
  invitationId: string;
  memberId: string;
  memberName: string;
  serviceWeekId: string;
  serviceDate: string;
  serviceWeekTitle: string | null;
  roleNote: string | null;
  invitationStatus: InvitationStatus;
  triggerReason: string | null;
  createdAt: string;
};

// GET /api/conflicts (#47) — set_leader/admin only. Lists OPEN conflicts
// (resolved_at IS NULL) for the caller's church group, joined in-memory with
// the related invitation/member/service-week rows (mirrors the multi-query
// join style of getChurchGroupMembers — no Supabase nested-join relationships
// exist on these hand-rolled types).
export async function getOpenConflicts(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: conflictRows, error: conflictsError } = await supabase
      .from("conflicts")
      .select("*")
      .eq("church_group_id", ctx.churchGroupId)
      .is("resolved_at", null)
      .order("created_at");

    if (conflictsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    const conflicts = conflictRows ?? [];

    const invitationIds = [...new Set(conflicts.map((c) => c.invitation_id))];

    let invitationRows: Pick<
      Database["public"]["Tables"]["invitations"]["Row"],
      "id" | "user_id" | "service_week_id" | "status" | "role_note"
    >[] = [];
    if (invitationIds.length > 0) {
      const { data, error } = await supabase
        .from("invitations")
        .select("id, user_id, service_week_id, status, role_note")
        .in("id", invitationIds);
      if (error) return fail("Internal error", ErrorCode.INTERNAL, 500);
      invitationRows = data ?? [];
    }
    const invitationById = new Map(invitationRows.map((inv) => [inv.id, inv]));

    const userIds = [...new Set(invitationRows.map((inv) => inv.user_id))];
    let userRows: Pick<Database["public"]["Tables"]["users"]["Row"], "id" | "name">[] = [];
    if (userIds.length > 0) {
      const { data, error } = await supabase.from("users").select("id, name").in("id", userIds);
      if (error) return fail("Internal error", ErrorCode.INTERNAL, 500);
      userRows = data ?? [];
    }
    const userById = new Map(userRows.map((u) => [u.id, u]));

    const serviceWeekIds = [...new Set(invitationRows.map((inv) => inv.service_week_id))];
    let weekRows: Pick<
      Database["public"]["Tables"]["service_weeks"]["Row"],
      "id" | "service_date" | "title"
    >[] = [];
    if (serviceWeekIds.length > 0) {
      const { data, error } = await supabase
        .from("service_weeks")
        .select("id, service_date, title")
        .in("id", serviceWeekIds);
      if (error) return fail("Internal error", ErrorCode.INTERNAL, 500);
      weekRows = data ?? [];
    }
    const weekById = new Map(weekRows.map((w) => [w.id, w]));

    const result: OpenConflict[] = conflicts.map((c) => {
      const invitation = invitationById.get(c.invitation_id);
      const member = invitation ? userById.get(invitation.user_id) : undefined;
      const week = invitation ? weekById.get(invitation.service_week_id) : undefined;
      return {
        id: c.id,
        invitationId: c.invitation_id,
        memberId: invitation?.user_id ?? "",
        memberName: member?.name ?? "",
        serviceWeekId: invitation?.service_week_id ?? "",
        serviceDate: week?.service_date ?? "",
        serviceWeekTitle: week?.title ?? null,
        roleNote: invitation?.role_note ?? null,
        // The invitation row backing a conflict should always exist (conflicts.
        // invitation_id is ON DELETE CASCADE from invitations) — "withdrawn" is
        // the safe fallback for the defensive case where the joined row is
        // nonetheless missing, so a stale entry reads as inactive rather than
        // silently pending.
        invitationStatus: invitation?.status ?? "withdrawn",
        triggerReason: c.trigger_reason,
        createdAt: c.created_at,
      };
    });

    return ok({ conflicts: result });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

export type ResolvedConflictResponse = {
  id: string;
  resolutionType: ResolutionType | null;
  resolvedAt: string | null;
};

// POST /api/conflicts/:id/resolve (#47) — set_leader/admin only. Resolves one
// OPEN conflict via one of three manual paths (`withdraw`,
// `member_reconfirmed`, `admin_dismissed`). No AI replacement suggestion path
// exists here (Phase 4, out of scope) and `replacement_suggestion_user_id` is
// never touched.
export async function resolveConflict(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = resolveConflictSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { resolution } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: conflict, error: conflictError } = await supabase
      .from("conflicts")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (conflictError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!conflict) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    // Idempotency: only the conflict's own resolved_at guards re-resolution —
    // a stale invitation status (already withdrawn/denied) below is NOT a 409.
    if (conflict.resolved_at !== null) {
      return fail("Conflict already resolved", ErrorCode.CONFLICT, 409);
    }

    let dbResolutionType: ResolutionType;

    if (resolution === "withdraw") {
      // Reuses #43's withdrawal logic, but the invitation here is `accepted`
      // (not `pending`), so unlike withdrawInvitation there is no
      // status !== "pending" 409 guard.
      const { data: invitation, error: invitationError } = await supabase
        .from("invitations")
        .select("*")
        .eq("id", conflict.invitation_id)
        .eq("church_group_id", ctx.churchGroupId)
        .maybeSingle();

      if (invitationError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
      if (!invitation) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }

      const invitationPatch: Database["public"]["Tables"]["invitations"]["Update"] = {
        status: "withdrawn",
      };
      const { error: updateInvitationError } = await supabase
        .from("invitations")
        .update(invitationPatch)
        .eq("id", invitation.id)
        .eq("church_group_id", ctx.churchGroupId);

      if (updateInvitationError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      // event_attendees has no service_week_id and delete cannot join, so
      // first find the week's events, then delete this member's attendance
      // rows across them. Idempotent no-op when the week has no events.
      const { data: eventsForWeek, error: eventsError } = await supabase
        .from("events")
        .select("id")
        .eq("service_week_id", invitation.service_week_id)
        .eq("church_group_id", ctx.churchGroupId);

      if (eventsError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      const eventIds = (eventsForWeek ?? []).map((e) => e.id);
      if (eventIds.length > 0) {
        const { error: deleteAttendeesError } = await supabase
          .from("event_attendees")
          .delete()
          .in("event_id", eventIds)
          .eq("user_id", invitation.user_id);

        if (deleteAttendeesError) {
          return fail("Internal error", ErrorCode.INTERNAL, 500);
        }
      }

      // TODO(#62): delete member's Google Calendar events for this week

      const { error: notifyError } = await supabase.from("notifications").insert({
        church_group_id: conflict.church_group_id,
        user_id: invitation.user_id,
        type: "invitation_withdrawn",
        title: "Invitation withdrawn",
        body: "Your set invitation was withdrawn",
        link_entity_type: "invitation",
        link_entity_id: invitation.id,
      } as Database["public"]["Tables"]["notifications"]["Insert"]);

      if (notifyError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      dbResolutionType = "withdrawn";
    } else if (resolution === "member_reconfirmed") {
      // Member stays on the roster — no invitations/event_attendees changes.
      dbResolutionType = "member_reconfirmed";
    } else {
      // admin_dismissed — member stays despite the flag; no changes either.
      dbResolutionType = "admin_dismissed";
    }

    // Mark the conflict resolved LAST, so a mid-operation failure above
    // leaves the conflict open and safely retryable.
    const conflictPatch: Database["public"]["Tables"]["conflicts"]["Update"] = {
      resolution_type: dbResolutionType,
      resolved_at: new Date().toISOString(),
    };
    const { data: updatedConflict, error: resolveError } = await supabase
      .from("conflicts")
      .update(conflictPatch)
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("*")
      .maybeSingle();

    if (resolveError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!updatedConflict) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    await writeAuditLog(supabase, {
      action: "conflict.resolved",
      entityType: "conflict",
      entityId: id,
      metadata: { resolution, invitation_id: conflict.invitation_id },
    });

    return ok<{ conflict: ResolvedConflictResponse }>({
      conflict: {
        id: updatedConflict.id,
        resolutionType: updatedConflict.resolution_type,
        resolvedAt: updatedConflict.resolved_at,
      },
    });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
