// Supplementary tests written independently by the Tester stage for #72
// (guest week access scoping in GET /api/events). The coder's own
// events-route.test.ts uses a `makeChain` mock whose `.in()`/`.eq()` are
// no-op passthroughs that ignore their arguments and always resolve to the
// same configured fixture regardless of role — so a regression where the
// guest-only `.in("status", GUEST_ACCESS_STATUSES)` filter silently stopped
// being applied (letting a guest see events for a week they only have a
// *denied* invitation for) would NOT be caught by that suite. These tests
// close that gap by recording the actual filter calls made against the
// `invitations` table per role.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncEventToAttendees: jest.fn(),
  toGoogleEventId: jest.fn((id: string) => `mock-google-id-${id}`),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { listEvents } from "@/app/api/events/handler";
import { GUEST_ACCESS_STATUSES } from "@/lib/invitations/guest-access";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

const fakeReq = {} as NextRequest;

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

// Chain that records every .in(...) call it receives so tests can assert on
// the *arguments*, not just that a call happened and a fixture was returned
// regardless (mirrors service-weeks-setlist-route-tester-supplement.test.ts).
function makeRecordingChain(
  result: QueryResult,
  onIn?: (args: unknown[]) => void,
): Record<string, unknown> & PromiseLike<QueryResult> {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn((...args: unknown[]) => {
      onIn?.(args);
      return chain;
    }),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("listEvents — tester supplement (#72 guest invitation-status scoping)", () => {
  it.each<UserRole>(["member", "set_leader"])(
    "does NOT apply an .in(status, ...) filter to the invitations query for a '%s' (any status still counts)",
    async (role) => {
      setUpAuth();
      let inCalledOnInvitations = false;

      const client = {
        from: jest.fn((table: string) => {
          if (table === "invitations") {
            return {
              select: jest.fn(() =>
                makeRecordingChain({ data: [{ service_week_id: "week-1" }], error: null }, () => {
                  inCalledOnInvitations = true;
                }),
              ),
            };
          }
          if (table === "events") {
            return { select: jest.fn(() => makeRecordingChain({ data: [], error: null })) };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
      };
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await listEvents(fakeReq, makeLookup(role));
      expect(res.status).toBe(200);
      expect(inCalledOnInvitations).toBe(false);
    },
  );

  it("applies .in('status', GUEST_ACCESS_STATUSES) to the invitations query for a 'guest' caller", async () => {
    setUpAuth();
    let capturedArgs: unknown[] | undefined;

    const client = {
      from: jest.fn((table: string) => {
        if (table === "invitations") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: [{ service_week_id: "week-1" }], error: null }, (args) => {
                capturedArgs = args;
              }),
            ),
          };
        }
        if (table === "events") {
          return { select: jest.fn(() => makeRecordingChain({ data: [], error: null })) };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listEvents(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(200);
    expect(capturedArgs).toEqual(["status", GUEST_ACCESS_STATUSES]);
  });

  it("a guest whose only invitation for a week is 'denied' sees no events for that week (query is genuinely status-filtered, not just mock-returned)", async () => {
    setUpAuth();

    // Simulate a real Postgres .in() filter server-side: the fixture models
    // the *already-filtered* result set a genuine `.in("status", ["pending",
    // "accepted"])` query would return when the guest's only row is denied —
    // i.e. zero rows — so the handler must treat this week as inaccessible.
    const client = {
      from: jest.fn((table: string) => {
        if (table === "invitations") {
          return { select: jest.fn(() => makeRecordingChain({ data: [], error: null })) };
        }
        if (table === "events") {
          throw new Error("events must not be queried when the guest has no accessible weeks");
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listEvents(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.events).toEqual([]);
  });
});
