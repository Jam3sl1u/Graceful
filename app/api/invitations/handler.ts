import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient, getAnonSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { writeAuditLog } from "@/lib/audit/write-audit-log";
import {
  createInvitationSchema,
  denyInvitationSchema,
  acceptInvitationParamSchema,
  acceptInvitationSchema,
  respondTokenParamSchema,
} from "@/schemas/invitations";
import type { EventType, InvitationStatus } from "@/types/domain";

type InvitationsRow = Database["public"]["Tables"]["invitations"]["Row"];

export type InvitationResponse = {
  id: string;
  serviceWeekId: string;
  userId: string;
  roleNote: string | null;
  status: InvitationStatus;
  responseToken: string;
  responseDeadline: string | null;
  invitedBy: string | null;
  createdAt: string;
};

export function toInvitationResponse(row: InvitationsRow): InvitationResponse {
  return {
    id: row.id,
    serviceWeekId: row.service_week_id,
    userId: row.user_id,
    roleNote: row.role_note,
    status: row.status,
    responseToken: row.response_token,
    responseDeadline: row.response_deadline,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  };
}

// Generates a 64-char hex response token: two crypto.randomUUID() calls with
// hyphens stripped, concatenated (32 hex chars each = 64 total). Matches the
// DB column response_token varchar(64) not null unique.
function generateResponseToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

// POST /api/invitations — set_leader/admin only (BR-05, PRD §22). Performs
// the double-booking check and records the invitation; the `conflicts` row
// itself is written at accept time (#41), not here.
export async function createInvitation(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = createInvitationSchema.safeParse(body);
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
      .select("*")
      .eq("id", parsed.serviceWeekId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (weekError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    // Missing and wrong-group are indistinguishable by construction (RLS +
    // the explicit church_group_id filter) — always 404, never 403 (mirrors
    // app/api/church-group/members/[id]/role/handler.ts).
    if (!week) {
      return fail("Service week not found", ErrorCode.NOT_FOUND, 404);
    }

    // BR-08 (PRD §8): a member who has denied 3 invitations for this service week
    // cannot be re-invited for it.
    const { data: deniedForWeek, error: deniedError } = await supabase
      .from("invitations")
      .select("id")
      .eq("user_id", parsed.userId)
      .eq("service_week_id", parsed.serviceWeekId)
      .eq("status", "denied");
    if (deniedError) return fail("Internal error", ErrorCode.INTERNAL, 500);
    if ((deniedForWeek ?? []).length >= 3) {
      return fail(
        "Member has denied 3 invitations for this week and cannot be re-invited (BR-08)",
        ErrorCode.CONFLICT,
        409,
      );
    }

    // BR-05 double-booking check: does this user already have an accepted
    // invitation for another service week on the same calendar date in this
    // group? No cross-table join helper exists, so this is two queries.
    const { data: acceptedInvitations, error: acceptedError } = await supabase
      .from("invitations")
      .select("service_week_id")
      .eq("user_id", parsed.userId)
      .eq("status", "accepted")
      .eq("church_group_id", ctx.churchGroupId);

    if (acceptedError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const acceptedWeekIds = [...new Set((acceptedInvitations ?? []).map((i) => i.service_week_id))];

    let hasConflict = false;
    if (acceptedWeekIds.length > 0) {
      const { data: collidingWeeks, error: collidingError } = await supabase
        .from("service_weeks")
        .select("id")
        .in("id", acceptedWeekIds)
        .eq("service_date", week.service_date)
        .neq("id", parsed.serviceWeekId);

      if (collidingError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      hasConflict = (collidingWeeks ?? []).length > 0;
    }

    if (hasConflict && parsed.acknowledgeConflict !== true) {
      return fail(
        "Member already confirmed for another week on this date",
        ErrorCode.CONFLICT,
        409,
      );
    }

    const token = generateResponseToken();
    const deadlineIso = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    // The hand-rolled Insert types in lib/supabase/types.ts mark some
    // DB-defaulted columns as required even though they have defaults —
    // cast narrowly here rather than widening the shared type (mirrors
    // app/api/service-weeks/handler.ts createServiceWeek).
    const invitationInsertPayload = {
      church_group_id: ctx.churchGroupId,
      service_week_id: parsed.serviceWeekId,
      user_id: parsed.userId,
      role_note: parsed.roleNote ?? null,
      response_token: token,
      response_deadline: deadlineIso,
      invited_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["invitations"]["Insert"];

    const { data: invitation, error: invitationError } = await supabase
      .from("invitations")
      .insert(invitationInsertPayload)
      .select("*")
      .maybeSingle();

    if (invitationError || !invitation) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    await writeAuditLog(supabase, {
      action: "invitation.sent",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: {
        service_week_id: parsed.serviceWeekId,
        user_id: parsed.userId,
        acknowledged_conflict: parsed.acknowledgeConflict === true,
      },
    });

    // TODO(#67/#68): dispatch SMS/email invitation notification here.

    return ok({ invitation: toInvitationResponse(invitation) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/invitations/:id/deny — works two ways (#49, mirrors
// acceptInvitation):
//   1. No-session (SMS/email link): body carries a `responseToken`, no Clerk
//      session; runs as the anon role through the deny_invitation SECURITY
//      DEFINER RPC, authenticated via the token itself.
//   2. In-app (authenticated member): no token; scoped to the caller's own
//      invitation (BR-08, PRD §6.3/§8/§12). Never leaks existence of another
//      user's invitation: not-owned/not-found/wrong-group all resolve to 404.
export async function denyInvitation(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const body = await req.json().catch(() => null);
    const parsedResult = denyInvitationSchema.safeParse(body ?? {});
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { responseToken } = parsedResult.data;
    const rawReason = parsedResult.data.reason;
    const reason = rawReason && rawReason.length > 0 ? rawReason : null;

    // No-session path: authenticated by the token itself inside the RPC, not
    // by a Clerk session — do not call requireAuth for this branch. Leaves
    // the existing authenticated (no-token) path below untouched.
    if (responseToken !== undefined) {
      const supabase = getAnonSupabaseClient();
      const { data, error } = await supabase.rpc("deny_invitation", {
        p_invitation_id: id,
        p_response_token: responseToken,
        p_reason: reason,
      });

      if (error) {
        const message = error.message ?? "";
        if (message.includes("NOT_FOUND")) {
          return fail("Not found", ErrorCode.NOT_FOUND, 404);
        }
        if (message.includes("FORBIDDEN")) {
          return fail("Forbidden", ErrorCode.FORBIDDEN, 403);
        }
        if (message.includes("EXPIRED")) {
          return fail("Invitation expired", ErrorCode.EXPIRED, 410);
        }
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      return ok({
        invitationId: id,
        status: data.status,
        alreadyResponded: data.already_responded,
      });
    }

    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: inv, error: invError } = await supabase
      .from("invitations")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (invError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!inv) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    // Idempotency (PRD §12): a link used after already responding returns the
    // current status with no side effects.
    if (inv.status !== "pending") {
      return ok({ invitation: toInvitationResponse(inv) });
    }

    // BR-08 denial_count is per member+week, counted across invitation rows
    // (incremented on each new invitation+deny pair, not globally per member).
    const { data: priorDenied, error: priorError } = await supabase
      .from("invitations")
      .select("id")
      .eq("user_id", inv.user_id)
      .eq("service_week_id", inv.service_week_id)
      .eq("status", "denied");
    if (priorError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    const denialCount = (priorDenied ?? []).length + 1;

    const patch: Database["public"]["Tables"]["invitations"]["Update"] = {
      status: "denied",
      denial_reason: reason,
      denial_count: denialCount,
      responded_at: new Date().toISOString(),
    };
    const { data: updated, error: updateError } = await supabase
      .from("invitations")
      .update(patch)
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .eq("user_id", ctx.userId)
      .select("*")
      .maybeSingle();

    if (updateError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!updated) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    await writeAuditLog(supabase, {
      action: "invitation.denied",
      entityType: "invitation",
      entityId: id,
      metadata: {
        service_week_id: inv.service_week_id,
        denial_count: denialCount,
        reason_provided: reason !== null,
      },
    });

    // TODO(#67/#68): dispatch SMS + email to invited_by (admin) with member name and reason.

    return ok({ invitation: toInvitationResponse(updated) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// DELETE /api/invitations/:id (#43) — set_leader/admin only. Withdraws a
// pending invitation: flips status to `withdrawn`, notifies the invited
// member in-app, and writes an audit log. Only valid while `pending` — an
// accepted invitation has event_attendees side-effects a plain status flip
// would not unwind (see .pipeline/spec.md Decision 1), so any other status
// is a 409 CONFLICT with no side effects.
export async function withdrawInvitation(
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

    const { data: inv, error: invError } = await supabase
      .from("invitations")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (invError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!inv) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    if (inv.status !== "pending") {
      return fail("Invitation is not pending", ErrorCode.CONFLICT, 409);
    }

    const patch: Database["public"]["Tables"]["invitations"]["Update"] = {
      status: "withdrawn",
    };
    const { data: updated, error: updateError } = await supabase
      .from("invitations")
      .update(patch)
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("*")
      .maybeSingle();

    if (updateError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!updated) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const { error: notifyError } = await supabase.from("notifications").insert({
      church_group_id: inv.church_group_id,
      user_id: inv.user_id,
      type: "invitation_withdrawn",
      title: "Invitation withdrawn",
      body: "Your set invitation was withdrawn",
      link_entity_type: "invitation",
      link_entity_id: inv.id,
    } as Database["public"]["Tables"]["notifications"]["Insert"]);

    if (notifyError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    await writeAuditLog(supabase, {
      action: "invitation.withdrawn",
      entityType: "invitation",
      entityId: id,
      metadata: {
        service_week_id: inv.service_week_id,
        user_id: inv.user_id,
      },
    });

    // Cancellation of reminders is automatic (#45): the reminder scheduler
    // selects on status = 'pending', so the withdraw above already stops
    // this invitation from being reminded again — nothing to do here.

    return ok({ invitation: toInvitationResponse(updated) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/invitations/:id/accept (#41) — works two ways:
//   1. No-session (SMS/email link): body carries a `responseToken`, no Clerk
//      session; runs as the anon role, authenticated via the token itself.
//   2. In-app (authenticated member): no token; identity comes from the
//      Clerk session, and the RPC requires the caller be the invitation's
//      own user.
// Both paths converge on the accept_invitation SECURITY DEFINER RPC, which
// does all validation and mutation atomically (status flip, event_attendees
// insert, admin notify, audit log).
export async function acceptInvitation(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const parsedId = acceptInvitationParamSchema.safeParse(id);
    if (!parsedId.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }

    const body = await req.json().catch(() => null);
    const parsedBody = acceptInvitationSchema.safeParse(body ?? {});
    if (!parsedBody.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { responseToken } = parsedBody.data;

    let supabase: ReturnType<typeof getSupabaseClient>;
    let pResponseToken: string | null;

    if (responseToken !== undefined) {
      supabase = getAnonSupabaseClient();
      pResponseToken = responseToken;
    } else {
      await requireAuth(req, lookup);

      const { getToken } = await auth();
      const jwt = await getToken({ template: "supabase" });
      if (!jwt) {
        return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
      }
      supabase = getSupabaseClient(jwt);
      pResponseToken = null;
    }

    const { data, error } = await supabase.rpc("accept_invitation", {
      p_invitation_id: parsedId.data,
      p_response_token: pResponseToken,
    });

    if (error) {
      const message = error.message ?? "";
      if (message.includes("NOT_FOUND")) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }
      if (message.includes("FORBIDDEN")) {
        return fail("Forbidden", ErrorCode.FORBIDDEN, 403);
      }
      if (message.includes("EXPIRED")) {
        return fail("Invitation expired", ErrorCode.EXPIRED, 410);
      }
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({
      invitationId: parsedId.data,
      status: data.status,
      alreadyResponded: data.already_responded,
      attendeesAdded: data.attendees_added,
    });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

export type PublicInvitationLookup = {
  invitationId: string;
  status: InvitationStatus;
  roleNote: string | null;
  responseDeadline: string | null;
  serviceWeek: { id: string; serviceDate: string; title: string | null };
  events: Array<{
    id: string;
    type: EventType;
    name: string;
    location: string | null;
    startTime: string;
    endTime: string;
  }>;
};

// GET /api/invitations/respond/:token (#44) — no-session, no-Clerk-auth,
// read-only lookup for someone tapping an SMS/email link. Token possession
// is the only credential; runs entirely through the get_invitation_by_token
// SECURITY DEFINER RPC via getAnonSupabaseClient() (mirrors the no-session
// branch of acceptInvitation).
export async function getInvitationByToken(token: string): Promise<Response> {
  // Anti-enumeration: a malformed token must return the SAME 404 as an unknown
  // one, so an attacker cannot distinguish "wrong format" from "not found".
  const parsed = respondTokenParamSchema.safeParse(token);
  if (!parsed.success) {
    return fail("Not found", ErrorCode.NOT_FOUND, 404);
  }

  try {
    const supabase = getAnonSupabaseClient();
    const { data, error } = await supabase.rpc("get_invitation_by_token", {
      p_response_token: parsed.data,
    });

    if (error) {
      if ((error.message ?? "").includes("NOT_FOUND")) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok<PublicInvitationLookup>({
      invitationId: data.invitation_id,
      status: data.status,
      roleNote: data.role_note,
      responseDeadline: data.response_deadline,
      serviceWeek: {
        id: data.service_week.id,
        serviceDate: data.service_week.service_date,
        title: data.service_week.title,
      },
      events: data.events.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        location: e.location,
        startTime: e.start_time,
        endTime: e.end_time,
      })),
    });
  } catch {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
