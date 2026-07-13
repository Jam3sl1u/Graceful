jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  deleteAvailability,
  getAvailability,
  setAvailability,
  type AvailabilityEntry,
} from "@/app/api/availability/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const CHURCH_GROUP_ID = "group-1";

function makeReq(opts: { query?: Record<string, string>; body?: unknown } = {}): NextRequest {
  const searchParams = new URLSearchParams(opts.query ?? {});
  return {
    nextUrl: { searchParams },
    json: jest.fn().mockResolvedValue(opts.body),
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole = "member"): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role,
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

function makeSupabaseClientForGet(result: QueryResult) {
  const order = jest.fn().mockResolvedValue(result);
  const eq = jest.fn(() => ({ order }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));
  return { from, select, eq, order };
}

function makeSupabaseClientForPut(
  result: QueryResult,
  onUpsert?: (payload: unknown, opts: unknown) => void,
  rpcResult: { data: unknown; error: unknown } = { data: false, error: null },
) {
  const select = jest.fn().mockResolvedValue(result);
  const upsert = jest.fn((payload: unknown, opts: unknown) => {
    onUpsert?.(payload, opts);
    return { select };
  });
  const from = jest.fn(() => ({ upsert }));
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  return { from, upsert, select, rpc };
}

// Mocks the two calls deleteAvailability makes: .from("availability").delete()
// .eq("user_id", ...).eq("date", ...), then a separate .rpc("record_availability_conflict", ...).
function makeSupabaseClientForDelete(
  deleteResult: { error: unknown },
  rpcResult: { data: unknown; error: unknown },
) {
  const eq2 = jest.fn().mockResolvedValue(deleteResult);
  const eq1 = jest.fn(() => ({ eq: eq2 }));
  const del = jest.fn(() => ({ eq: eq1 }));
  const from = jest.fn(() => ({ delete: del }));
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  return { from, delete: del, eq1, eq2, rpc };
}

const rowA = {
  user_id: USER_ID,
  date: "2026-01-05",
  is_available: true,
  note: null,
};
const rowB = {
  user_id: USER_ID,
  date: "2026-01-10",
  is_available: false,
  note: "Out of town",
};

describe("GET /api/availability", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getAvailability(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getAvailability(makeReq(), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed (non-uuid) user_id", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForGet({ data: [], error: null }));

    const res = await getAvailability(makeReq({ query: { user_id: "not-a-uuid" } }), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("200 for own id (any role, e.g. plain member) — no role gate required", async () => {
    setUpAuth();
    const client = makeSupabaseClientForGet({ data: [rowA, rowB], error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getAvailability(makeReq(), makeLookup("member"));
    expect(res.status).toBe(200);
    expect(client.eq).toHaveBeenCalledWith("user_id", USER_ID);

    const body = await res.json();
    const availability: AvailabilityEntry[] = body.data.availability;
    expect(availability).toEqual([
      { userId: USER_ID, date: "2026-01-05", isAvailable: true, note: null },
      { userId: USER_ID, date: "2026-01-10", isAvailable: false, note: "Out of town" },
    ]);
  });

  it("returns 403 FORBIDDEN when a plain member requests another user's availability", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForGet({ data: [], error: null }));

    const res = await getAvailability(
      makeReq({ query: { user_id: "11111111-1111-1111-1111-111111111111" } }),
      makeLookup("member"),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it.each<UserRole>(["set_leader", "admin"])(
    "returns 200 when a '%s' requests another user's availability",
    async (role) => {
      setUpAuth();
      const otherId = "11111111-1111-1111-1111-111111111111";
      const client = makeSupabaseClientForGet({
        data: [{ ...rowA, user_id: otherId }],
        error: null,
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await getAvailability(makeReq({ query: { user_id: otherId } }), makeLookup(role));
      expect(res.status).toBe(200);
      expect(client.eq).toHaveBeenCalledWith("user_id", otherId);
    },
  );

  it("returns 500 INTERNAL when the select returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClientForGet({ data: null, error: { message: "connection refused" } }),
    );

    const res = await getAvailability(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 200 with availability: [] when there are no stored rows (does not synthesize defaults)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForGet({ data: [], error: null }));

    const res = await getAvailability(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.availability).toEqual([]);
  });
});

describe("PUT /api/availability", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await setAvailability(makeReq({ body: { entries: [] } }), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for empty entries: []", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(makeReq({ body: { entries: [] } }), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for malformed body (null)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(makeReq({ body: null }), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when an entry has both date and a range field", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05", startDate: "2026-01-01" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when an entry has neither date nor a range", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(
      makeReq({ body: { entries: [{ isAvailable: true }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when only startDate is present (no endDate)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(
      makeReq({ body: { entries: [{ startDate: "2026-01-01" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when startDate > endDate", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(
      makeReq({ body: { entries: [{ startDate: "2026-01-10", endDate: "2026-01-01" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for an invalid calendar date (2026-02-30)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-02-30" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when the expanded total exceeds 366 dates", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForPut({ data: [], error: null }));

    const res = await setAvailability(
      makeReq({
        body: { entries: [{ startDate: "2025-01-01", endDate: "2026-01-02" }] }, // 367 days
      }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("allows an expanded total of exactly 366 dates (leap-year boundary)", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut({ data: [rowA], error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    // 2024-01-01 .. 2024-12-31 inclusive = 366 days (2024 is a leap year).
    const res = await setAvailability(
      makeReq({ body: { entries: [{ startDate: "2024-01-01", endDate: "2024-12-31" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.upsert).toHaveBeenCalled();
    const rows = client.upsert.mock.calls[0]?.[0] as unknown[];
    expect(rows).toHaveLength(366);
  });

  it("expands a range spanning a month boundary into every inclusive date", async () => {
    setUpAuth();
    let capturedRows: Array<{ date: string }> | undefined;
    const client = makeSupabaseClientForPut({ data: [rowA], error: null }, (payload) => {
      capturedRows = payload as Array<{ date: string }>;
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ startDate: "2026-01-30", endDate: "2026-02-02" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(capturedRows?.map((r) => r.date)).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("dedupes overlapping dates across entries, last-entry-wins, single upsert call", async () => {
    setUpAuth();
    let capturedRows: Array<{ date: string; is_available: boolean; note: string | null }> | undefined;
    const client = makeSupabaseClientForPut({ data: [rowA], error: null }, (payload) => {
      capturedRows = payload as typeof capturedRows;
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({
        body: {
          entries: [
            { startDate: "2026-01-01", endDate: "2026-01-03", isAvailable: false, note: "first" },
            { date: "2026-01-02", isAvailable: true, note: "second (wins)" },
          ],
        },
      }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.upsert).toHaveBeenCalledTimes(1);
    expect(capturedRows).toHaveLength(3);
    const jan2 = capturedRows?.find((r) => r.date === "2026-01-02");
    expect(jan2).toEqual({
      user_id: USER_ID,
      church_group_id: CHURCH_GROUP_ID,
      date: "2026-01-02",
      is_available: true,
      note: "second (wins)",
    });
  });

  it("defaults isAvailable to true when omitted", async () => {
    setUpAuth();
    let capturedRows: Array<{ is_available: boolean }> | undefined;
    const client = makeSupabaseClientForPut(
      { data: [{ ...rowA, is_available: true }], error: null },
      (payload) => {
        capturedRows = payload as typeof capturedRows;
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(capturedRows?.[0]?.is_available).toBe(true);

    const body = await res.json();
    const availability: AvailabilityEntry[] = body.data.availability;
    expect(availability[0]?.isAvailable).toBe(true);
  });

  it("normalizes empty/whitespace note to null", async () => {
    setUpAuth();
    let capturedRows: Array<{ note: string | null }> | undefined;
    const client = makeSupabaseClientForPut(
      { data: [{ ...rowA, note: null }], error: null },
      (payload) => {
        capturedRows = payload as typeof capturedRows;
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05", note: "   " }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(capturedRows?.[0]?.note).toBeNull();

    const body = await res.json();
    const availability: AvailabilityEntry[] = body.data.availability;
    expect(availability[0]?.note).toBeNull();
  });

  it("upserts with onConflict user_id,date (re-setting an existing date updates in place)", async () => {
    setUpAuth();
    let capturedOpts: unknown;
    const client = makeSupabaseClientForPut({ data: [rowB], error: null }, (_payload, opts) => {
      capturedOpts = opts;
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-10", isAvailable: false, note: "Out of town" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toEqual({ onConflict: "user_id,date" });

    const body = await res.json();
    const availability: AvailabilityEntry[] = body.data.availability;
    expect(availability).toEqual([
      { userId: USER_ID, date: "2026-01-10", isAvailable: false, note: "Out of town" },
    ]);
  });

  it("returns 500 INTERNAL when the upsert returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClientForPut({ data: null, error: { message: "constraint violation" } }),
    );

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("scopes PUT to the caller's own user id/church group regardless of role (no other-user path exists)", async () => {
    setUpAuth();
    let capturedRows: Array<{ user_id: string; church_group_id: string }> | undefined;
    const client = makeSupabaseClientForPut({ data: [rowA], error: null }, (payload) => {
      capturedRows = payload as typeof capturedRows;
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05" }] } }),
      makeLookup("member"),
    );
    expect(res.status).toBe(200);
    expect(capturedRows?.[0]).toEqual({
      user_id: USER_ID,
      church_group_id: CHURCH_GROUP_ID,
      date: "2026-01-05",
      is_available: true,
      note: null,
    });
    expect(capturedRows?.[0]?.user_id).not.toBe(OTHER_USER_ID);
  });

  // BR-15 (#46): the explicit "mark unavailable" PUT is the other trigger
  // point that shares record_availability_conflict with the DELETE path.
  it("BR-15: marking a date unavailable calls the conflict-detection RPC and reports conflictTriggered: true", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut({ data: [rowB], error: null }, undefined, {
      data: true,
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-10", isAvailable: false, note: "Out of town" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("record_availability_conflict", {
      p_date: "2026-01-10",
      p_trigger_reason: "marked_unavailable",
    });

    const body = await res.json();
    expect(body.data.conflictTriggered).toBe(true);
  });

  it("marking a date available (or omitted, defaulting to true) does not call the conflict-detection RPC", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut({ data: [rowA], error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-05" }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    expect(client.rpc).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.data.conflictTriggered).toBe(false);
  });

  it("a multi-date PUT calls the conflict-detection RPC once per unavailable date only", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut({ data: [rowA, rowB], error: null }, undefined, {
      data: true,
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({
        body: {
          entries: [
            { date: "2026-01-05", isAvailable: true },
            { date: "2026-01-10", isAvailable: false, note: "Out of town" },
          ],
        },
      }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("record_availability_conflict", {
      p_date: "2026-01-10",
      p_trigger_reason: "marked_unavailable",
    });
  });

  it("returns 500 INTERNAL when the conflict-detection RPC returns an error", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut({ data: [rowB], error: null }, undefined, {
      data: null,
      error: { message: "connection refused" },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ body: { entries: [{ date: "2026-01-10", isAvailable: false }] } }),
      makeLookup(),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("DELETE /api/availability/:date", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await deleteAvailability(makeReq(), "2026-01-05", lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await deleteAvailability(makeReq(), "2026-01-05", makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed date param", async () => {
    setUpAuth();

    const res = await deleteAvailability(makeReq(), "not-a-date", makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for an invalid calendar date (2026-02-30)", async () => {
    setUpAuth();

    const res = await deleteAvailability(makeReq(), "2026-02-30", makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  // Core BR-15 acceptance criterion (#35): deleting an availability row for a
  // date with an accepted invitation must fire the same conflict-detection
  // flow as explicitly toggling unavailable — not be silently ignored.
  it("BR-15: triggers the conflict-detection flow when an accepted invitation exists for the deleted date", async () => {
    setUpAuth();
    const client = makeSupabaseClientForDelete({ error: null }, { data: true, error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await deleteAvailability(makeReq(), "2026-01-05", makeLookup());
    expect(res.status).toBe(200);

    expect(client.delete).toHaveBeenCalledTimes(1);
    expect(client.eq1).toHaveBeenCalledWith("user_id", USER_ID);
    expect(client.eq2).toHaveBeenCalledWith("date", "2026-01-05");

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("record_availability_conflict", {
      p_date: "2026-01-05",
      p_trigger_reason: "availability_deleted",
    });

    const body = await res.json();
    expect(body.data).toEqual({ date: "2026-01-05", conflictTriggered: true });
  });

  it("is a no-op beyond clearing the record when no accepted invitation exists for the date", async () => {
    setUpAuth();
    const client = makeSupabaseClientForDelete({ error: null }, { data: false, error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await deleteAvailability(makeReq(), "2026-01-05", makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ date: "2026-01-05", conflictTriggered: false });
  });

  it("returns 500 INTERNAL when the delete returns an error (conflict RPC never called)", async () => {
    setUpAuth();
    const client = makeSupabaseClientForDelete(
      { error: { message: "connection refused" } },
      { data: false, error: null },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await deleteAvailability(makeReq(), "2026-01-05", makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the conflict-detection RPC returns an error", async () => {
    setUpAuth();
    const client = makeSupabaseClientForDelete(
      { error: null },
      { data: null, error: { message: "connection refused" } },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await deleteAvailability(makeReq(), "2026-01-05", makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("scopes the delete to the caller's own user id regardless of role", async () => {
    setUpAuth();
    const client = makeSupabaseClientForDelete({ error: null }, { data: false, error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await deleteAvailability(makeReq(), "2026-01-05", makeLookup("member"));
    expect(res.status).toBe(200);
    expect(client.eq1).toHaveBeenCalledWith("user_id", USER_ID);
    expect(client.eq1).not.toHaveBeenCalledWith("user_id", OTHER_USER_ID);
  });
});
