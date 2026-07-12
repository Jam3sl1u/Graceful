// Supplementary tests written independently by the Tester stage for #39
// (BR-17). The coder's own service-weeks-cancel-route.test.ts and
// service-weeks-reactivate-route.test.ts never assert the *arguments*
// passed to the invitations `.in("status", [...])` call — their mock chain's
// `in` is a no-op passthrough that ignores arguments entirely, so a bug
// where the handler filtered on the wrong statuses (e.g. included "denied")
// would not be caught by the existing suite. These tests close that gap and
// add a couple of additional independent checks called out in changes.md's
// "What the Tester should focus on" section.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { cancelServiceWeek, reactivateServiceWeek } from "@/app/api/service-weeks/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";

const fakeReq = {} as NextRequest;

function makeLookup(): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role: "admin",
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

// Chain that records every .eq(...) and .in(...) call it receives so tests
// can assert on the *arguments*, not just that the call happened.
function makeRecordingChain(
  result: QueryResult,
  onEq?: (args: unknown[]) => void,
  onIn?: (args: unknown[]) => void,
) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((...args: unknown[]) => {
      onEq?.(args);
      return chain;
    }),
    in: jest.fn((...args: unknown[]) => {
      onIn?.(args);
      return chain;
    }),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("cancelServiceWeek / reactivateServiceWeek — tester supplement", () => {
  it("filters the invitations recipient query on status IN ['pending', 'accepted'] (not all statuses)", async () => {
    setUpAuth();
    const inCalls: unknown[][] = [];

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            update: jest.fn(() =>
              makeRecordingChain({
                data: { id: WEEK_ID, church_group_id: CHURCH_GROUP_ID, is_cancelled: true },
                error: null,
              }),
            ),
          };
        }
        if (table === "invitations") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: [], error: null }, undefined, (args) =>
                inCalls.push(args),
              ),
            ),
          };
        }
        if (table === "notifications") {
          return {
            insert: jest.fn(() => makeRecordingChain({ data: null, error: null })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup());
    expect(res.status).toBe(200);

    expect(inCalls).toEqual([["status", ["pending", "accepted"]]]);
  });

  it("does not notify recipients whose only invitations are denied/withdrawn/expired (simulated via empty result from the pre-filtered query)", async () => {
    // The handler delegates status filtering to the DB via `.in(...)`. This
    // test simulates the DB honoring that filter: a week with ONLY
    // denied/withdrawn/expired invitations must resolve to zero recipients
    // from the recipient query, and therefore no notifications insert.
    setUpAuth();
    let insertCalled = false;

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            update: jest.fn(() =>
              makeRecordingChain({
                data: { id: WEEK_ID, church_group_id: CHURCH_GROUP_ID, is_cancelled: true },
                error: null,
              }),
            ),
          };
        }
        if (table === "invitations") {
          // Simulates status IN ('pending','accepted') returning nothing
          // because the only rows are denied/withdrawn/expired.
          return {
            select: jest.fn(() => makeRecordingChain({ data: [], error: null })),
          };
        }
        if (table === "notifications") {
          return {
            insert: jest.fn((payload: unknown) => {
              insertCalled = true;
              return makeRecordingChain({ data: payload, error: null });
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup());
    expect(res.status).toBe(200);
    expect(insertCalled).toBe(false);
  });

  it("reactivate uses the same status filter as cancel (['pending', 'accepted'])", async () => {
    setUpAuth();
    const inCalls: unknown[][] = [];

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            update: jest.fn(() =>
              makeRecordingChain({
                data: { id: WEEK_ID, church_group_id: CHURCH_GROUP_ID, is_cancelled: false },
                error: null,
              }),
            ),
          };
        }
        if (table === "invitations") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: [], error: null }, undefined, (args) =>
                inCalls.push(args),
              ),
            ),
          };
        }
        if (table === "notifications") {
          return {
            insert: jest.fn(() => makeRecordingChain({ data: null, error: null })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await reactivateServiceWeek(fakeReq, WEEK_ID, makeLookup());
    expect(res.status).toBe(200);

    expect(inCalls).toEqual([["status", ["pending", "accepted"]]]);
  });

  it("cancel and reactivate are independent: cancelling never sets is_cancelled false and vice versa", async () => {
    setUpAuth();
    const updatePatches: unknown[] = [];

    function clientFor(finalIsCancelled: boolean) {
      return {
        from: jest.fn((table: string) => {
          if (table === "service_weeks") {
            return {
              update: jest.fn((patch: unknown) => {
                updatePatches.push(patch);
                return makeRecordingChain({
                  data: {
                    id: WEEK_ID,
                    church_group_id: CHURCH_GROUP_ID,
                    is_cancelled: finalIsCancelled,
                  },
                  error: null,
                });
              }),
            };
          }
          if (table === "invitations") {
            return { select: jest.fn(() => makeRecordingChain({ data: [], error: null })) };
          }
          if (table === "notifications") {
            return { insert: jest.fn(() => makeRecordingChain({ data: null, error: null })) };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
      };
    }

    mockGetSupabaseClient.mockReturnValue(clientFor(true));
    const cancelRes = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup());
    expect(cancelRes.status).toBe(200);

    mockGetSupabaseClient.mockReturnValue(clientFor(false));
    const reactivateRes = await reactivateServiceWeek(fakeReq, WEEK_ID, makeLookup());
    expect(reactivateRes.status).toBe(200);

    expect(updatePatches).toEqual([{ is_cancelled: true }, { is_cancelled: false }]);
  });
});
