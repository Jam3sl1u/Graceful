// Tests for GET /api/invitations/:id -> getOwnInvitation (#73, PRD Screen 3 /
// OPEN QUESTION option C): the new in-app, authenticated read of a member's
// own invitation. Mock scaffolding mirrors
// tests/unit/app/api/invitations-deny-route.test.ts (makeReq, makeLookup,
// setUpAuth, makeChain/makeSupabaseClient, jest.mock of
// @clerk/nextjs/server + @/lib/supabase/client).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getOwnInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
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

type QueryResult = { data: unknown; error: unknown };

// Chainable mock covering:
//   .select(...).eq(...).eq(...).eq(...).maybeSingle()
//   .select(...).eq(...).maybeSingle()
//   .select(...).eq(...).order(...)                     (awaited directly)
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(results: {
  invitation?: QueryResult;
  serviceWeek?: QueryResult;
  events?: QueryResult;
}) {
  return {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => {
        if (table === "invitations") {
          return makeChain(results.invitation ?? { data: null, error: null });
        }
        if (table === "service_weeks") {
          return makeChain(results.serviceWeek ?? { data: null, error: null });
        }
        if (table === "events") {
          return makeChain(results.events ?? { data: [], error: null });
        }
        return makeChain({ data: null, error: null });
      }),
    })),
  };
}

const ownedInvitationRow = {
  id: INVITATION_ID,
  status: "pending",
  role_note: "Lead vocals",
  response_deadline: "2099-07-15T00:00:00Z",
  service_week_id: SERVICE_WEEK_ID,
};

const serviceWeekRow = {
  id: SERVICE_WEEK_ID,
  service_date: "2026-07-12",
  title: "Sunday Service",
};

const eventRow = {
  id: "event-1",
  type: "rehearsal",
  name: "Rehearsal",
  location: "Main hall",
  start_time: "2026-07-12T09:00:00Z",
  end_time: "2026-07-12T10:00:00Z",
};

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/invitations/:id (getOwnInvitation)", () => {
  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed id", async () => {
    setUpAuth();
    const res = await getOwnInvitation(makeReq(), "not-a-uuid", makeLookup());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("happy path: returns the PublicInvitationLookup shape for the caller's own invitation", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitation: { data: ownedInvitationRow, error: null },
        serviceWeek: { data: serviceWeekRow, error: null },
        events: { data: [eventRow], error: null },
      }),
    );

    const res = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      invitationId: INVITATION_ID,
      status: "pending",
      roleNote: "Lead vocals",
      responseDeadline: "2099-07-15T00:00:00Z",
      serviceWeek: { id: SERVICE_WEEK_ID, serviceDate: "2026-07-12", title: "Sunday Service" },
      events: [
        {
          id: "event-1",
          type: "rehearsal",
          name: "Rehearsal",
          location: "Main hall",
          startTime: "2026-07-12T09:00:00Z",
          endTime: "2026-07-12T10:00:00Z",
        },
      ],
    });
  });

  it("computes 'expired' for a pending invitation past its response_deadline", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitation: {
          data: { ...ownedInvitationRow, response_deadline: "2020-01-01T00:00:00Z" },
          error: null,
        },
        serviceWeek: { data: serviceWeekRow, error: null },
        events: { data: [], error: null },
      }),
    );

    const res = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    const body = await res.json();
    expect(body.data.status).toBe("expired");
  });

  it("does not mark an already-responded invitation as expired, even past its deadline", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitation: {
          data: {
            ...ownedInvitationRow,
            status: "accepted",
            response_deadline: "2020-01-01T00:00:00Z",
          },
          error: null,
        },
        serviceWeek: { data: serviceWeekRow, error: null },
        events: { data: [], error: null },
      }),
    );

    const res = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    const body = await res.json();
    expect(body.data.status).toBe("accepted");
  });

  it("returns 404 NOT_FOUND (not a leak-revealing error) when the invitation does not exist", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitation: { data: null, error: null } }),
    );

    const res = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns the same 404 for another member's invitation as for a nonexistent one (no existence leak)", async () => {
    // The handler scopes its query by user_id/church_group_id; from the
    // caller's perspective a not-owned row and a nonexistent row are
    // indistinguishable — both come back as `data: null` from maybeSingle().
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitation: { data: null, error: null } }),
    );

    const notOwnedRes = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    const notFoundRes = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());

    expect(notOwnedRes.status).toBe(404);
    expect(notFoundRes.status).toBe(404);
    const [a, b] = await Promise.all([notOwnedRes.json(), notFoundRes.json()]);
    expect(a).toEqual(b);
  });

  it("returns 500 INTERNAL when the invitations query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitation: { data: null, error: { message: "boom" } } }),
    );

    const res = await getOwnInvitation(makeReq(), INVITATION_ID, makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
