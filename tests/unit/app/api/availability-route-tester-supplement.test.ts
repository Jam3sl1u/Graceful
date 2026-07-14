// Supplementary tests written independently by the Tester stage for #46
// (conflict detection on availability change — the PUT trigger point).
//
// The coder's own availability-route.test.ts covers the happy path and the
// spec's named edge cases well, but leaves a few gaps this file closes:
//   1. It never asserts that an upsert error short-circuits BEFORE the
//      conflict-detection RPC is even attempted (spec: "after the upsert
//      succeeds" — a regression that fired the RPC unconditionally would
//      still pass the existing 500 assertion since it only checks status).
//   2. It never exercises a multi-date RANGE where every expanded date is
//      unavailable — the existing multi-date test only mixes one available +
//      one unavailable date, which wouldn't catch a regression that only
//      fires the RPC for the first or last date in a byDate iteration.
//   3. It never asserts call ORDER: the spec requires the upsert (which
//      writes the is_available:false row + note) to run before the RPC, so
//      the RPC can read that note. A regression reordering these two calls
//      wouldn't be caught by any existing assertion (they only check
//      "was called", not "was called after").

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { setAvailability } from "@/app/api/availability/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(body: unknown): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams() },
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "member" };
  return async () => ctx;
}

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(JWT),
  });
}

type QueryResult = { data: unknown; error: unknown };

function makeSupabaseClientForPut(
  result: QueryResult,
  rpcResult: { data: unknown; error: unknown } = { data: false, error: null },
) {
  const select = jest.fn().mockResolvedValue(result);
  const upsert = jest.fn(() => ({ select }));
  const from = jest.fn(() => ({ upsert }));
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  return { from, upsert, select, rpc };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("setAvailability — tester supplement (#46)", () => {
  it("never calls the conflict-detection RPC when the upsert itself errors", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut(
      { data: null, error: { message: "constraint violation" } },
      { data: true, error: null }, // would report a conflict if it were ever (wrongly) called
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ entries: [{ date: "2026-01-10", isAvailable: false, note: "Out of town" }] }),
      makeLookup(),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("fires the conflict-detection RPC once per unavailable date across a multi-day range (not just the first/last)", async () => {
    setUpAuth();
    const rows = [
      { user_id: USER_ID, date: "2026-03-01", is_available: false, note: "away" },
      { user_id: USER_ID, date: "2026-03-02", is_available: false, note: "away" },
      { user_id: USER_ID, date: "2026-03-03", is_available: false, note: "away" },
    ];
    const client = makeSupabaseClientForPut({ data: rows, error: null }, { data: true, error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({
        entries: [
          { startDate: "2026-03-01", endDate: "2026-03-03", isAvailable: false, note: "away" },
        ],
      }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    expect(client.rpc).toHaveBeenCalledTimes(3);
    const calledDates = client.rpc.mock.calls.map(
      (call) => (call[1] as { p_date: string }).p_date,
    );
    expect(calledDates.sort()).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    for (const call of client.rpc.mock.calls) {
      expect(call[1]).toMatchObject({ p_trigger_reason: "marked_unavailable" });
    }

    const body = await res.json();
    expect(body.data.conflictTriggered).toBe(true);
  });

  it("calls the upsert before the conflict-detection RPC (so the RPC can read the just-written note)", async () => {
    setUpAuth();
    const client = makeSupabaseClientForPut(
      { data: [{ user_id: USER_ID, date: "2026-01-10", is_available: false, note: "Out of town" }], error: null },
      { data: true, error: null },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await setAvailability(
      makeReq({ entries: [{ date: "2026-01-10", isAvailable: false, note: "Out of town" }] }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    const upsertOrder = client.upsert.mock.invocationCallOrder[0];
    const rpcOrder = client.rpc.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeDefined();
    expect(rpcOrder).toBeDefined();
    expect(upsertOrder as number).toBeLessThan(rpcOrder as number);
  });
});
