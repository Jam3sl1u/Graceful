jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { lookupUserByClerkId } from "@/lib/api/auth";
import { ApiException } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

function makeSupabaseChain(result: { data: unknown; error: unknown }) {
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { from, select, eq, maybeSingle };
}

const CLERK_ID = "user_clerk123";

const dbRow = {
  id: "uuid-1",
  church_group_id: "group-uuid-1",
  role: "admin" as const,
};

const expectedCtx: AuthContext = {
  userId: "uuid-1",
  churchGroupId: "group-uuid-1",
  role: "admin",
};

describe("lookupUserByClerkId", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("happy path — row found → returns mapped AuthContext", async () => {
    const mockGetToken = jest.fn().mockResolvedValue("supabase-jwt");
    mockAuth.mockResolvedValue({ getToken: mockGetToken });
    const chain = makeSupabaseChain({ data: dbRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ from: chain.from });

    const result = await lookupUserByClerkId(CLERK_ID);

    expect(mockGetToken).toHaveBeenCalledWith({ template: "supabase" });
    expect(mockGetSupabaseClient).toHaveBeenCalledWith("supabase-jwt");
    expect(chain.from).toHaveBeenCalledWith("users");
    expect(chain.select).toHaveBeenCalledWith("id, church_group_id, role");
    expect(chain.eq).toHaveBeenCalledWith("clerk_id", CLERK_ID);
    expect(result).toEqual(expectedCtx);
  });

  it("no matching row → returns null", async () => {
    const mockGetToken = jest.fn().mockResolvedValue("supabase-jwt");
    mockAuth.mockResolvedValue({ getToken: mockGetToken });
    const chain = makeSupabaseChain({ data: null, error: null });
    mockGetSupabaseClient.mockReturnValue({ from: chain.from });

    const result = await lookupUserByClerkId(CLERK_ID);

    expect(result).toBeNull();
  });

  it("Supabase error → throws ApiException 500 INTERNAL", async () => {
    const mockGetToken = jest.fn().mockResolvedValue("supabase-jwt");
    mockAuth.mockResolvedValue({ getToken: mockGetToken });
    const chain = makeSupabaseChain({ data: null, error: { message: "DB connection refused" } });
    mockGetSupabaseClient.mockReturnValue({ from: chain.from });

    await expect(lookupUserByClerkId(CLERK_ID)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
    await expect(lookupUserByClerkId(CLERK_ID)).rejects.toBeInstanceOf(ApiException);
  });

  it("missing JWT (getToken returns null) → returns null", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(null);
    mockAuth.mockResolvedValue({ getToken: mockGetToken });

    const result = await lookupUserByClerkId(CLERK_ID);

    expect(result).toBeNull();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });
});
