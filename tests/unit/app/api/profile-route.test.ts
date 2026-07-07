jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getProfile, updateProfile, type ProfileResponse } from "@/app/api/profile/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role: "member",
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

const profileRow = { id: "profile-1", vocal_capability: "lead", bio: "Some bio" };
const memberInstrumentsRows = [{ member_profile_id: "profile-1", instrument_id: "instr-1" }];
const instrumentsRows = [{ id: "instr-1", name: "Guitar" }];

type QueryResult = { data: unknown; error: unknown };

function makeSupabaseClient(
  overrides: Partial<Record<string, QueryResult>> = {},
  onUpsert?: (table: string, payload: unknown, opts: unknown) => void,
) {
  const fixtures: Record<string, QueryResult> = {
    member_profiles: { data: profileRow, error: null },
    member_instruments: { data: memberInstrumentsRows, error: null },
    instruments: { data: instrumentsRows, error: null },
    ...overrides,
  };

  return {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => {
        const result = fixtures[table];
        const chain = Promise.resolve(result) as Promise<QueryResult> & {
          eq: jest.Mock;
        };
        chain.eq = jest.fn(() => {
          const eqChain = Promise.resolve(result) as Promise<QueryResult> & {
            maybeSingle: jest.Mock;
          };
          eqChain.maybeSingle = jest.fn(() => Promise.resolve(result));
          return eqChain;
        });
        return chain;
      }),
      upsert: jest.fn((payload: unknown, opts: unknown) => {
        onUpsert?.(table, payload, opts);
        return {
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() => Promise.resolve(fixtures[table])),
          })),
        };
      }),
    })),
  };
}

describe("GET /api/profile", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getProfile(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getProfile(makeReq(), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 200 with an existing profile, instruments correctly name-mapped", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getProfile(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    const profile: ProfileResponse = body.data.profile;
    expect(profile).toEqual({
      userId: USER_ID,
      vocalCapability: "lead",
      bio: "Some bio",
      instruments: [{ id: "instr-1", name: "Guitar" }],
    });
  });

  it("returns 200 with synthesized defaults when no member_profiles row exists", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ member_profiles: { data: null, error: null } }),
    );

    const res = await getProfile(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    const profile: ProfileResponse = body.data.profile;
    expect(profile).toEqual({
      userId: USER_ID,
      vocalCapability: "none",
      bio: null,
      instruments: [],
    });
  });

  it("skips a member_instruments row whose instrument_id has no matching instrument", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        member_instruments: {
          data: [
            { member_profile_id: "profile-1", instrument_id: "instr-1" },
            { member_profile_id: "profile-1", instrument_id: "instr-missing" },
          ],
          error: null,
        },
      }),
    );

    const res = await getProfile(makeReq(), makeLookup());
    const body = await res.json();
    const profile: ProfileResponse = body.data.profile;
    expect(profile.instruments).toEqual([{ id: "instr-1", name: "Guitar" }]);
  });

  it("returns 500 INTERNAL when the member_profiles query returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        member_profiles: { data: null, error: { message: "connection refused" } },
      }),
    );

    const res = await getProfile(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("PUT /api/profile", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 400 VALIDATION_FAILED when vocalCapability is not lead/harmony/both/none", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateProfile(
      makeReq({ vocalCapability: "soprano", bio: "hi" }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when body is malformed / missing vocalCapability", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateProfile(makeReq(null), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 200 and updates an existing profile", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { member_profiles: { data: { ...profileRow, vocal_capability: "both" }, error: null } },
        (table, payload) => {
          if (table === "member_profiles") capturedPayload = payload;
        },
      ),
    );

    const res = await updateProfile(
      makeReq({ vocalCapability: "both", bio: "Updated bio" }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const profile: ProfileResponse = body.data.profile;
    expect(profile.vocalCapability).toBe("both");
    expect(capturedPayload).toEqual({
      user_id: USER_ID,
      vocal_capability: "both",
      bio: "Updated bio",
    });
  });

  it("returns 200 and upserts (creates) a profile for a member who had none", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        member_profiles: {
          data: { id: "profile-new", vocal_capability: "harmony", bio: null },
          error: null,
        },
        member_instruments: { data: [], error: null },
      }),
    );

    const res = await updateProfile(
      makeReq({ vocalCapability: "harmony", bio: null }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const profile: ProfileResponse = body.data.profile;
    expect(profile).toEqual({
      userId: USER_ID,
      vocalCapability: "harmony",
      bio: null,
      instruments: [],
    });
  });

  it("normalizes empty/whitespace bio to null", async () => {
    setUpAuth();
    let capturedPayload: { bio: unknown } | undefined;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { member_profiles: { data: { ...profileRow, bio: null }, error: null } },
        (table, payload) => {
          if (table === "member_profiles") capturedPayload = payload as { bio: unknown };
        },
      ),
    );

    const res = await updateProfile(makeReq({ vocalCapability: "lead", bio: "   " }), makeLookup());
    expect(res.status).toBe(200);

    expect(capturedPayload?.bio).toBeNull();
    const body = await res.json();
    const profile: ProfileResponse = body.data.profile;
    expect(profile.bio).toBeNull();
  });

  it("returns 500 INTERNAL when the upsert returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        member_profiles: { data: null, error: { message: "constraint violation" } },
      }),
    );

    const res = await updateProfile(makeReq({ vocalCapability: "lead", bio: "x" }), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await updateProfile(makeReq({ vocalCapability: "lead", bio: "x" }), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });
});
