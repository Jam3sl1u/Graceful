import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { writeAuditLog } from "@/lib/audit/write-audit-log";

const targetIdSchema = z.string().uuid();

// DELETE /api/church-group/members/:id — right-to-erasure removal (Issue
// #28, PRD §25.6), not a hard delete. The whole operation (404 check, BR-12
// last-admin guard, PII anonymization, cross-table cleanup) runs as one
// atomic SECURITY DEFINER RPC (remove_church_group_member,
// supabase/migrations/20260710000001_member_removal_rpc.sql), the same
// shape as POST /api/church-group/join — a plain-client sequence can't do
// this atomically and can't clear another user's owner-scoped rows
// (notification_preferences, notifications, google_calendar_tokens) under
// RLS. requireRole(ctx, ["admin"]) below is a fast client-side fail; the
// RPC's own caller-role check is the load-bearing "Admin only" enforcement.
export async function deleteMember(
  req: NextRequest,
  targetUserId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const idResult = targetIdSchema.safeParse(targetUserId);
    if (!idResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase.rpc("remove_church_group_member", {
      p_target_user_id: targetUserId,
    });

    if (error) {
      if (error.message.includes("NOT_FOUND")) {
        return fail("Member not found", ErrorCode.NOT_FOUND, 404);
      }
      if (error.message.includes("LAST_ADMIN")) {
        return fail(
          "Cannot remove the last remaining admin in the church group",
          ErrorCode.VALIDATION_FAILED,
          422,
        );
      }
      if (error.message.includes("FORBIDDEN")) {
        return fail("Insufficient permissions", ErrorCode.FORBIDDEN, 403);
      }
      if (error.message.includes("UNAUTHENTICATED")) {
        return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
      }
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) return fail("Internal error", ErrorCode.INTERNAL, 500);

    // Empty metadata is deliberate: logging the removed member's
    // pre-anonymization PII into the audit log would undercut the erasure
    // this endpoint performs.
    await writeAuditLog(supabase, {
      action: "member.removed",
      entityType: "user",
      entityId: targetUserId,
      metadata: {},
    });

    return ok({ id: targetUserId });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
