jest.mock("@/lib/supabase/client", () => ({
  getAnonSupabaseClient: jest.fn(),
}));

import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { getInvitationByToken } from "@/app/api/invitations/handler";

const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;

const TOKEN = "a".repeat(64);
const INVITATION_ID = "11111111-1111-1111-1111-111111111111";
const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";

function makeRpcClient(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn(() => Promise.resolve(result)) };
}

function baseRpcData(overrides: Record<string, unknown> = {}) {
  return {
    invitation_id: INVITATION_ID,
    status: "pending",
    role_note: "Lead vocals",
    response_deadline: "2026-07-15T00:00:00.000Z",
    service_week: {
      id: SERVICE_WEEK_ID,
      service_date: "2026-07-19",
      title: "Sunday Service",
    },
    events: [
      {
        id: EVENT_ID,
        type: "rehearsal",
        name: "Rehearsal",
        location: "Main Hall",
        start_time: "2026-07-18T18:00:00.000Z",
        end_time: "2026-07-18T20:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetAnonSupabaseClient.mockReset();
});

describe("GET /api/invitations/respond/:token", () => {
  it("happy path (pending): 200, camelCase body, uses getAnonSupabaseClient", async () => {
    const client = makeRpcClient({ data: baseRpcData(), error: null });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      invitationId: INVITATION_ID,
      status: "pending",
      roleNote: "Lead vocals",
      responseDeadline: "2026-07-15T00:00:00.000Z",
      serviceWeek: {
        id: SERVICE_WEEK_ID,
        serviceDate: "2026-07-19",
        title: "Sunday Service",
      },
      events: [
        {
          id: EVENT_ID,
          type: "rehearsal",
          name: "Rehearsal",
          location: "Main Hall",
          startTime: "2026-07-18T18:00:00.000Z",
          endTime: "2026-07-18T20:00:00.000Z",
        },
      ],
    });

    expect(mockGetAnonSupabaseClient).toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("get_invitation_by_token", {
      p_response_token: TOKEN,
    });
  });

  it("expired (>72h, still pending): 200 with computed expired status, not an error", async () => {
    const client = makeRpcClient({ data: baseRpcData({ status: "expired" }), error: null });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.status).toBe("expired");
    expect(body.data.invitationId).toBe(INVITATION_ID);
  });

  it.each(["accepted", "denied", "withdrawn"])(
    "already responded (%s): 200 with the real status",
    async (status) => {
      const client = makeRpcClient({ data: baseRpcData({ status }), error: null });
      mockGetAnonSupabaseClient.mockReturnValue(client);

      const res = await getInvitationByToken(TOKEN);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe(status);
    },
  );

  it("unknown token (valid format, no row): maps RPC NOT_FOUND to 404", async () => {
    const client = makeRpcClient({ data: null, error: { message: "NOT_FOUND" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });

  it("malformed token (wrong length): identical 404, RPC never called", async () => {
    const res = await getInvitationByToken("short");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ error: "Not found", code: "NOT_FOUND" });
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("malformed token (non-hex): identical 404, RPC never called", async () => {
    const res = await getInvitationByToken("z".repeat(64));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ error: "Not found", code: "NOT_FOUND" });
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("empty events: week with no events yet returns events: []", async () => {
    const client = makeRpcClient({ data: baseRpcData({ events: [] }), error: null });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.events).toEqual([]);
  });

  it("unexpected RPC error: maps to 500 INTERNAL", async () => {
    const client = makeRpcClient({ data: null, error: { message: "unexpected db error" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
