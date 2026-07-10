import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { writeAuditLog } from "@/lib/audit/write-audit-log";
import { updateRoleSchema } from "@/schemas/role";

const targetIdSchema = z.string().uuid();

// PATCH /api/church-group/members/:id/role — the only route allowed to write
// users.role (BR-03/BR-04/BR-12, PRD §7). requireRole(ctx, ["admin"]) below is
// the sole enforcement of that: users_update_leader_admin RLS also permits
// set_leader to UPDATE same-group users rows (no column-level granularity), so
// the app-layer check here is load-bearing, not defense in depth.
export async function patchMemberRole(
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

    const body = await req.json().catch(() => null);
    const parsedResult = updateRoleSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { role: newRole } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: target, error: targetErr } = await supabase
      .from("users")
      .select("id, role")
      .eq("id", targetUserId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (targetErr) return fail("Internal error", ErrorCode.INTERNAL, 500);
    // Missing and wrong-group are indistinguishable by construction (RLS +
    // the explicit church_group_id filter) — always 404, never 403, so we
    // don't leak cross-tenant existence. 403 is reserved for the caller's
    // own role check above.
    if (!target) return fail("Member not found", ErrorCode.NOT_FOUND, 404);

    if (target.role === "admin" && newRole !== "admin") {
      const { count, error: countErr } = await supabase
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("church_group_id", ctx.churchGroupId)
        .eq("role", "admin");

      if (countErr) return fail("Internal error", ErrorCode.INTERNAL, 500);
      if ((count ?? 0) <= 1) {
        return fail(
          "Cannot demote the last remaining admin in the church group",
          ErrorCode.VALIDATION_FAILED,
          422,
        );
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from("users")
      .update({ role: newRole })
      .eq("id", targetUserId)
      .eq("church_group_id", ctx.churchGroupId)
      .select("id, role")
      .maybeSingle();

    if (updateErr || !updated) return fail("Internal error", ErrorCode.INTERNAL, 500);

    await writeAuditLog(supabase, {
      action: "user.role_changed",
      entityType: "user",
      entityId: targetUserId,
      metadata: { old_value: target.role, new_value: newRole },
    });

    return ok({ id: updated.id, role: updated.role });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
