// Supplementary tests written independently by the Tester stage for #70
// (BR-14 minimum-channel guard). The coder's own
// notification-preferences-route.test.ts fixture couples the pre-write
// select and the post-write upsert result to the same `error` field, so it
// never actually exercises the handler's `error || !data` branch on the
// *upsert* call specifically (as opposed to the pre-write select) — a bug
// where the handler forgot to check the upsert's own error/data would slip
// through. It also never asserts the exact SELECT column list (that
// chat_preference is never requested), never checks the integer boundary
// values (1 and 168) are accepted, and never drives the route.ts delegation
// wrapper directly. This file closes those gaps.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { updateNotificationPreferences } from "@/app/api/notifications/preferences/handler";
import { GET, PUT } from "@/app/api/notifications/preferences/route";
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

const defaultsRow = {
  invitation_sms: true,
  invitation_email: true,
  invitation_inapp: true,
  reminder_sms: true,
  reminder_email: false,
  reminder_hours_before: 24,
  setlist_sms: true,
  setlist_email: true,
  gcal_sync_enabled: false,
};

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("updateNotificationPreferences — upsert-specific failure paths", () => {
  it("returns 500 INTERNAL when the pre-write select succeeds but the upsert itself errors", async () => {
    setUpAuth();
    const selectCols: string[] = [];
    mockGetSupabaseClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn((cols: string) => {
          selectCols.push(cols);
          const chain = Promise.resolve({ data: defaultsRow, error: null }) as Promise<{
            data: unknown;
            error: unknown;
          }> & { eq: jest.Mock };
          chain.eq = jest.fn(() => {
            const eqChain = Promise.resolve({ data: defaultsRow, error: null }) as Promise<{
              data: unknown;
              error: unknown;
            }> & { maybeSingle: jest.Mock };
            eqChain.maybeSingle = jest.fn(() =>
              Promise.resolve({ data: defaultsRow, error: null }),
            );
            return eqChain;
          });
          return chain;
        }),
        upsert: jest.fn(() => ({
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() =>
              Promise.resolve({ data: null, error: { message: "constraint violation" } }),
            ),
          })),
        })),
      })),
    });

    const res = await updateNotificationPreferences(
      makeReq({ reminderEmail: true }),
      makeLookup(),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    // Sanity check the select never asked for chat_preference.
    expect(selectCols.every((c) => !c.includes("chat_preference"))).toBe(true);
  });

  it("returns 500 INTERNAL when the upsert reports no error but also returns no row", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => {
          const chain = Promise.resolve({ data: defaultsRow, error: null }) as Promise<{
            data: unknown;
            error: unknown;
          }> & { eq: jest.Mock };
          chain.eq = jest.fn(() => {
            const eqChain = Promise.resolve({ data: defaultsRow, error: null }) as Promise<{
              data: unknown;
              error: unknown;
            }> & { maybeSingle: jest.Mock };
            eqChain.maybeSingle = jest.fn(() =>
              Promise.resolve({ data: defaultsRow, error: null }),
            );
            return eqChain;
          });
          return chain;
        }),
        upsert: jest.fn(() => ({
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
          })),
        })),
      })),
    });

    const res = await updateNotificationPreferences(makeReq({}), makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("reminderHoursBefore boundary values", () => {
  it.each([1, 168])("accepts the boundary value %p", async (value) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => {
          const chain = Promise.resolve({ data: defaultsRow, error: null }) as Promise<{
            data: unknown;
            error: unknown;
          }> & { eq: jest.Mock };
          chain.eq = jest.fn(() => {
            const eqChain = Promise.resolve({ data: defaultsRow, error: null }) as Promise<{
              data: unknown;
              error: unknown;
            }> & { maybeSingle: jest.Mock };
            eqChain.maybeSingle = jest.fn(() =>
              Promise.resolve({ data: defaultsRow, error: null }),
            );
            return eqChain;
          });
          return chain;
        }),
        upsert: jest.fn((payload: { reminder_hours_before: number }) => ({
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() =>
              Promise.resolve({ data: { ...defaultsRow, ...payload }, error: null }),
            ),
          })),
        })),
      })),
    });

    const res = await updateNotificationPreferences(
      makeReq({ reminderHoursBefore: value }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.preferences.reminderHoursBefore).toBe(value);
  });
});

describe("updateNotificationPreferences — full unauthenticated case", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted, no Supabase client built)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await updateNotificationPreferences(
      makeReq({ reminderEmail: true }),
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });
});

// Builds a fake Supabase client whose `.from(table)` behavior differs by
// table name, so route.ts's default (real) `requireAuth` -> `users` lookup
// can be satisfied alongside the `notification_preferences` query, letting
// these tests drive the actual exported route handlers end-to-end (not the
// underlying `handler.ts` functions directly, unlike every other test in
// this suite).
function makeMultiTableClient(usersRow: unknown, prefsRow: unknown) {
  function chainFor(result: { data: unknown; error: unknown }) {
    const chain = Promise.resolve(result) as Promise<typeof result> & { eq: jest.Mock };
    chain.eq = jest.fn(() => {
      const eqChain = Promise.resolve(result) as Promise<typeof result> & {
        maybeSingle: jest.Mock;
      };
      eqChain.maybeSingle = jest.fn(() => Promise.resolve(result));
      return eqChain;
    });
    return chain;
  }

  return {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => {
        if (table === "users") return chainFor({ data: usersRow, error: null });
        return chainFor({ data: prefsRow, error: null });
      }),
    })),
  };
}

describe("route.ts delegation", () => {
  it("GET delegates to getNotificationPreferences and returns its response", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeMultiTableClient(
        { id: USER_ID, church_group_id: CHURCH_GROUP_ID, role: "member" },
        null,
      ),
    );

    // route.ts's GET doesn't accept a lookup param (production shape uses
    // requireAuth's default DB lookup), so we drive it with no lookup arg,
    // matching how Next.js itself calls it.
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.preferences.userId).toBe(USER_ID);
  });

  it("PUT delegates to updateNotificationPreferences and propagates a validation failure", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeMultiTableClient(
        { id: USER_ID, church_group_id: CHURCH_GROUP_ID, role: "member" },
        null,
      ),
    );
    const res = await PUT(makeReq(null));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });
});
