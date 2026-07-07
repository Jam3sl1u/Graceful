import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ApiException, ErrorCode } from "@/lib/api/errors";

// action uses dot-notation, e.g. "user.role_changed", "member.removed",
// "invitation.sent", "group.created". Free-form string (DB limit: 100 chars).
export type AuditLogEntry = {
  action: string; // dot-notation; max 100 chars (DB varchar(100))
  entityType: string; // e.g. "user", "invitation"; max 50 chars (DB varchar(50))
  entityId: string; // uuid of the affected entity
  metadata?: Record<string, unknown>; // arbitrary JSON; defaults to {}
};

// Appends one immutable audit row for the caller's user + church group (both
// derived server-side from the JWT inside the write_audit_log RPC). `supabase`
// MUST be the RLS-scoped client for the acting user (getSupabaseClient(jwt)).
// Throws ApiException(INTERNAL, 500) on DB error; never swallows.
export async function writeAuditLog(
  supabase: SupabaseClient<Database>,
  entry: AuditLogEntry,
): Promise<void> {
  const { error } = await supabase.rpc("write_audit_log", {
    p_action: entry.action,
    p_entity_type: entry.entityType,
    p_entity_id: entry.entityId,
    p_metadata: entry.metadata ?? {},
  });

  if (error) {
    throw new ApiException("Internal error", ErrorCode.INTERNAL, 500);
  }
}
