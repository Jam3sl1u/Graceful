import { writeAuditLog, type AuditLogEntry } from "@/lib/audit/write-audit-log";
import { ApiException } from "@/lib/api/errors";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

function makeSupabaseClient(rpcResult: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  return { rpc } as unknown as SupabaseClient<Database>;
}

describe("writeAuditLog", () => {
  it("calls the write_audit_log RPC with the exact arg keys, metadata passed through", async () => {
    const supabase = makeSupabaseClient({ data: { id: "row-1" }, error: null });
    const entry: AuditLogEntry = {
      action: "user.role_changed",
      entityType: "user",
      entityId: "entity-1",
      metadata: { old_value: "member", new_value: "set_leader" },
    };

    await writeAuditLog(supabase, entry);

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("write_audit_log", {
      p_action: "user.role_changed",
      p_entity_type: "user",
      p_entity_id: "entity-1",
      p_metadata: { old_value: "member", new_value: "set_leader" },
    });
  });

  it("defaults metadata to {} when omitted, never undefined", async () => {
    const supabase = makeSupabaseClient({ data: { id: "row-2" }, error: null });
    const entry: AuditLogEntry = {
      action: "member.removed",
      entityType: "user",
      entityId: "entity-2",
    };

    await writeAuditLog(supabase, entry);

    expect(supabase.rpc).toHaveBeenCalledWith("write_audit_log", {
      p_action: "member.removed",
      p_entity_type: "user",
      p_entity_id: "entity-2",
      p_metadata: {},
    });
    const [, args] = (supabase.rpc as jest.Mock).mock.calls[0];
    expect(args.p_metadata).not.toBeUndefined();
  });

  it("resolves void on success", async () => {
    const supabase = makeSupabaseClient({ data: { id: "row-3" }, error: null });
    await expect(
      writeAuditLog(supabase, {
        action: "group.created",
        entityType: "church_group",
        entityId: "entity-3",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws ApiException(INTERNAL, 500) on RPC error and never swallows it", async () => {
    const supabase = makeSupabaseClient({
      data: null,
      error: { message: "connection refused" },
    });

    await expect(
      writeAuditLog(supabase, {
        action: "invitation.sent",
        entityType: "invitation",
        entityId: "entity-4",
      }),
    ).rejects.toThrow(ApiException);

    await expect(
      writeAuditLog(supabase, {
        action: "invitation.sent",
        entityType: "invitation",
        entityId: "entity-4",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
