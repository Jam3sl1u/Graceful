import { recordAvailabilityConflict } from "@/lib/scheduling/conflict-detection";
import { ApiException } from "@/lib/api/errors";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

function makeSupabaseClient(rpcResult: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  return { rpc } as unknown as SupabaseClient<Database>;
}

describe("recordAvailabilityConflict", () => {
  it("calls the record_availability_conflict RPC with the exact arg keys", async () => {
    const supabase = makeSupabaseClient({ data: true, error: null });

    await recordAvailabilityConflict(supabase, "2026-08-01", "availability_deleted");

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("record_availability_conflict", {
      p_date: "2026-08-01",
      p_trigger_reason: "availability_deleted",
    });
  });

  it("returns true when the RPC reports a conflict was recorded", async () => {
    const supabase = makeSupabaseClient({ data: true, error: null });

    await expect(
      recordAvailabilityConflict(supabase, "2026-08-01", "availability_deleted"),
    ).resolves.toBe(true);
  });

  it("returns false when the RPC reports no accepted invitation existed (no-op path)", async () => {
    const supabase = makeSupabaseClient({ data: false, error: null });

    await expect(
      recordAvailabilityConflict(supabase, "2026-08-01", "availability_deleted"),
    ).resolves.toBe(false);
  });

  it("throws ApiException(INTERNAL, 500) on RPC error and never swallows it", async () => {
    const supabase = makeSupabaseClient({ data: null, error: { message: "connection refused" } });

    await expect(
      recordAvailabilityConflict(supabase, "2026-08-01", "availability_deleted"),
    ).rejects.toThrow(ApiException);

    await expect(
      recordAvailabilityConflict(supabase, "2026-08-01", "availability_deleted"),
    ).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
