import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { auditLogQuerySchema } from "@/schemas/audit-log";

export type AuditLogItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  userId: string | null; // nullable per schema (system actions)
  metadata: Record<string, unknown>;
  createdAt: string; // ISO timestamp
};

// GET /api/church-group/audit-log — paginated, admin-only, read-only view of
// the caller's church group's audit trail. RLS (audit_logs_select_admin)
// already scopes rows to admins in the same group; requireRole is defense in
// depth so non-admins get 403 FORBIDDEN instead of a silently empty list.
export async function getAuditLog(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const parsedResult = auditLogQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { page, pageSize } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const { data, error, count } = await supabase
      .from("audit_logs")
      .select("id, action, entity_type, entity_id, user_id, metadata, created_at", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak
      .range(from, to);

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const entries: AuditLogItem[] = (data ?? []).map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      userId: row.user_id,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));

    return ok({ entries, pagination: { page, pageSize, total: count ?? 0 } });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
