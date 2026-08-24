// Supplemental independent tests for GET /api/invitations/respond/:token
// (issue #44), written by the Tester stage to cross-check claims in
// changes.md that the coder's own test file
// (invitations-respond-route.test.ts) doesn't directly exercise:
//   - the anti-enumeration guarantee is checked there via two *separate*
//     assertions against a literal object; this file additionally asserts
//     the unknown-token and malformed-token responses are byte-identical to
//     *each other* (deep-equal, including status code), which is what the
//     acceptance criterion actually requires.
//   - failure paths where getAnonSupabaseClient() itself throws, or the RPC
//     promise rejects (as opposed to resolving with `{ error }`), are not
//     covered by the coder's suite at all.
//   - a token that matches in length but uses uppercase hex (regex only
//     allows lowercase a-f) must be treated as malformed, not forwarded to
//     the RPC.
//   - null-valued optional fields (roleNote, responseDeadline, service week
//     title) pass through as null rather than being coerced/dropped.

jest.mock("@/lib/supabase/client", () => ({
  getAnonSupabaseClient: jest.fn(),
}));

import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { getInvitationByToken } from "@/app/api/invitations/handler";

const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;

const TOKEN = "a".repeat(64);
const INVITATION_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";

function makeRpcClient(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn(() => Promise.resolve(result)) };
}

beforeEach(() => {
  mockGetAnonSupabaseClient.mockReset();
});

describe("GET /api/invitations/respond/:token — supplemental tester coverage", () => {
  it("unknown token and malformed token produce byte-identical responses (status + body)", async () => {
    const client = makeRpcClient({ data: null, error: { message: "NOT_FOUND" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const unknownRes = await getInvitationByToken(TOKEN);
    const unknownBody = await unknownRes.json();

    mockGetAnonSupabaseClient.mockReset();
    const malformedRes = await getInvitationByToken("not-a-valid-token");
    const malformedBody = await malformedRes.json();

    expect(malformedRes.status).toBe(unknownRes.status);
    expect(malformedBody).toEqual(unknownBody);
    // The malformed path must never touch the RPC/anon client at all.
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("rejects an otherwise well-formed token that uses uppercase hex (regex is lowercase-only) without calling the RPC", async () => {
    const res = await getInvitationByToken("A".repeat(64));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ error: "Not found", code: "NOT_FOUND" });
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("failure case: getAnonSupabaseClient() throwing synchronously is caught and maps to 500 INTERNAL", async () => {
    mockGetAnonSupabaseClient.mockImplementation(() => {
      throw new Error("no service role env var configured");
    });

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ error: "Internal error", code: "INTERNAL" });
  });

  it("failure case: the RPC promise rejecting (network failure) is caught and maps to 500 INTERNAL", async () => {
    const client = { rpc: jest.fn(() => Promise.reject(new Error("fetch failed"))) };
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ error: "Internal error", code: "INTERNAL" });
  });

  it("passes through null roleNote, null responseDeadline, and null service week title unchanged", async () => {
    const client = makeRpcClient({
      data: {
        invitation_id: INVITATION_ID,
        status: "pending",
        role_note: null,
        response_deadline: null,
        service_week: {
          id: SERVICE_WEEK_ID,
          service_date: "2026-07-19",
          title: null,
        },
        events: [],
      },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await getInvitationByToken(TOKEN);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.roleNote).toBeNull();
    expect(body.data.responseDeadline).toBeNull();
    expect(body.data.serviceWeek.title).toBeNull();
  });
});
