jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  getChurchGroupMembers,
  type DirectoryMember,
} from "@/app/api/church-group/members/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const fakeReq = {} as NextRequest;
const JWT = "supabase-jwt";
const CHURCH_GROUP_ID = "group-1";

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: "user-1",
    churchGroupId: CHURCH_GROUP_ID,
    role,
  };
  return async () => ctx;
}

const usersRows = [
  { id: "user-1", name: "Caller Admin", role: "admin", email: "admin@example.com", phone: "555-0001" },
  { id: "user-2", name: "Member Two", role: "member", email: "member2@example.com", phone: "555-0002" },
  { id: "user-3", name: "Member Three (no profile)", role: "member", email: null, phone: null },
];

const profilesRows = [{ id: "profile-2", user_id: "user-2", vocal_capability: "lead" }];

const instrumentsRows = [{ id: "instr-1", name: "Guitar" }];

const memberInstrumentsRows = [{ member_profile_id: "profile-2", instrument_id: "instr-1" }];

type QueryResult = { data: unknown; error: unknown };

function makeSupabaseClient(overrides: Partial<Record<string, QueryResult>> = {}) {
  const fixtures: Record<string, QueryResult> = {
    users: { data: usersRows, error: null },
    member_profiles: { data: profilesRows, error: null },
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
        chain.eq = jest.fn(() => Promise.resolve(result));
        return chain;
      }),
    })),
  };
}

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(JWT),
  });
}

describe("GET /api/church-group/members", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getChurchGroupMembers(fakeReq, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN when role = 'guest'", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("200 for role = 'admin' -> members include email + phone keys", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;
    expect(members).toHaveLength(3);
    for (const member of members) {
      expect("email" in member).toBe(true);
      expect("phone" in member).toBe(true);
    }
    const admin = members.find((m) => m.id === "user-1")!;
    expect(admin.email).toBe("admin@example.com");
    expect(admin.phone).toBe("555-0001");
  });

  it.each<UserRole>(["member", "set_leader"])(
    "200 for role = '%s' -> member objects have no email/phone keys",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await getChurchGroupMembers(fakeReq, makeLookup(role));
      expect(res.status).toBe(200);

      const body = await res.json();
      const members: DirectoryMember[] = body.data.members;
      expect(members).toHaveLength(3);
      for (const member of members) {
        expect("email" in member).toBe(false);
        expect("phone" in member).toBe(false);
      }
    },
  );

  it("maps instruments correctly for the member with a profile", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;

    const memberTwo = members.find((m) => m.id === "user-2")!;
    expect(memberTwo.vocalCapability).toBe("lead");
    expect(memberTwo.instruments).toEqual([{ id: "instr-1", name: "Guitar" }]);
  });

  it("user without a member_profiles row gets vocalCapability 'none' and empty instruments, still present", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;

    const memberThree = members.find((m) => m.id === "user-3")!;
    expect(memberThree).toBeDefined();
    expect(memberThree.vocalCapability).toBe("none");
    expect(memberThree.instruments).toEqual([]);
  });

  it("every member has availabilityStatus: null", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;

    for (const member of members) {
      expect(member.availabilityStatus).toBeNull();
    }
  });

  it("returns 500 INTERNAL when any query returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ users: { data: null, error: { message: "connection refused" } } }),
    );

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 401 UNAUTHENTICATED when getToken resolves no JWT (Clerk session present)", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk_test",
      getToken: jest.fn().mockResolvedValue(null),
    });

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("skips a member_instruments row whose instrument_id has no matching instruments row", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        member_instruments: {
          data: [
            { member_profile_id: "profile-2", instrument_id: "instr-1" },
            { member_profile_id: "profile-2", instrument_id: "instr-missing" },
          ],
          error: null,
        },
      }),
    );

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;

    const memberTwo = members.find((m) => m.id === "user-2")!;
    expect(memberTwo.instruments).toEqual([{ id: "instr-1", name: "Guitar" }]);
  });

  it("a user with a profile but no member_instruments rows gets instruments: []", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ member_instruments: { data: [], error: null } }),
    );

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;

    const memberTwo = members.find((m) => m.id === "user-2")!;
    expect(memberTwo.vocalCapability).toBe("lead");
    expect(memberTwo.instruments).toEqual([]);
  });

  it("returns a one-element array when the caller is the only user in the group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        users: { data: [usersRows[0]], error: null },
        member_profiles: { data: [], error: null },
        member_instruments: { data: [], error: null },
      }),
    );

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const members: DirectoryMember[] = body.data.members;
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe("user-1");
  });
});
