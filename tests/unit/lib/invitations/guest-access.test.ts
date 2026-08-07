import { guestHasWeekAccess, GUEST_ACCESS_STATUSES } from "@/lib/invitations/guest-access";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

type QueryResult = { data: unknown; error: unknown };

// Chainable mock covering:
//   .select(...).eq(...).eq(...).in(...).limit(1)  (awaited directly)
function makeSupabaseClient(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;

  return {
    from: jest.fn(() => ({ select: jest.fn(() => chain) })),
  } as unknown as SupabaseClient<Database>;
}

describe("guestHasWeekAccess", () => {
  it("GUEST_ACCESS_STATUSES is exactly pending and accepted", () => {
    expect(GUEST_ACCESS_STATUSES).toEqual(["pending", "accepted"]);
  });

  it("allowed: true when a pending invitation row exists", async () => {
    const supabase = makeSupabaseClient({ data: [{ id: "invitation-1" }], error: null });
    const result = await guestHasWeekAccess(supabase, "week-1", "user-1");
    expect(result).toEqual({ allowed: true, dbError: false });
  });

  it("allowed: true when an accepted invitation row exists", async () => {
    const supabase = makeSupabaseClient({ data: [{ id: "invitation-2" }], error: null });
    const result = await guestHasWeekAccess(supabase, "week-1", "user-1");
    expect(result).toEqual({ allowed: true, dbError: false });
  });

  it("allowed: false when there are no rows", async () => {
    const supabase = makeSupabaseClient({ data: [], error: null });
    const result = await guestHasWeekAccess(supabase, "week-1", "user-1");
    expect(result).toEqual({ allowed: false, dbError: false });
  });

  it("allowed: false when only a denied invitation exists (query already filters status, but null data degrades safely too)", async () => {
    const supabase = makeSupabaseClient({ data: null, error: null });
    const result = await guestHasWeekAccess(supabase, "week-1", "user-1");
    expect(result).toEqual({ allowed: false, dbError: false });
  });

  it("dbError: true on a query error (never throws)", async () => {
    const supabase = makeSupabaseClient({ data: null, error: { message: "connection refused" } });
    const result = await guestHasWeekAccess(supabase, "week-1", "user-1");
    expect(result).toEqual({ allowed: false, dbError: true });
  });

  it("allowed: true for a re-invited guest with multiple matching rows (no .maybeSingle() error)", async () => {
    const supabase = makeSupabaseClient({
      data: [{ id: "invitation-1" }, { id: "invitation-2" }],
      error: null,
    });
    const result = await guestHasWeekAccess(supabase, "week-1", "user-1");
    expect(result).toEqual({ allowed: true, dbError: false });
  });
});
