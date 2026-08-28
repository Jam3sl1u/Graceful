// Supplementary tests written independently by the Tester stage for #72
// (POST /api/invitations/guest). The coder's own
// invitations-guest-route.test.ts uses per-table chainable fixtures whose
// `.eq()`/`.is()` are no-op passthroughs that ignore their arguments and
// always resolve to the configured fixture regardless of what was actually
// queried — so a regression where the existing-user lookup forgot to scope
// by church_group_id, forgot to exclude anonymized users, or a new-user
// provisioning call used the wrong (un-normalized) email would NOT be
// caught by that suite. These tests close that gap by recording the actual
// arguments passed to `.eq()`/`.is()`/`rpc()`.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { createGuestInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const OTHER_CHURCH_GROUP_ID = "group-EVIL";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";

function makeReq(body?: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}

function makeLookup(churchGroupId = CHURCH_GROUP_ID): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId, role: "admin" };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

// Chain that records every .eq(...)/.is(...) call so tests can assert on the
// *arguments*, mirroring service-weeks-setlist-route-tester-supplement.test.ts.
function makeRecordingChain(
  result: QueryResult,
  record?: (method: string, args: unknown[]) => void,
): Record<string, unknown> & PromiseLike<QueryResult> {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((...args: unknown[]) => {
      record?.("eq", args);
      return chain;
    }),
    ilike: jest.fn((...args: unknown[]) => {
      record?.("ilike", args);
      return chain;
    }),
    is: jest.fn((...args: unknown[]) => {
      record?.("is", args);
      return chain;
    }),
    limit: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

const serviceWeekRow = {
  id: SERVICE_WEEK_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_date: "2026-07-12",
  title: "Sunday Service",
  is_cancelled: false,
};

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("createGuestInvitation — tester supplement (query-shape verification)", () => {
  it("scopes the existing-user lookup by the caller's own church_group_id, the invited email, and excludes anonymized users", async () => {
    setUpAuth();
    const calls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return { select: jest.fn(() => makeRecordingChain({ data: serviceWeekRow, error: null })) };
        }
        if (table === "users") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: [], error: null }, (method, args) =>
                calls.push({ method, args }),
              ),
            ),
          };
        }
        throw new Error(`Unexpected table in this test: ${table}`);
      }),
      rpc: jest.fn(() =>
        Promise.resolve({
          data: { id: "new-guest-1", clerk_id: "pending_guest_x" },
          error: null,
        }),
      ),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    await createGuestInvitation(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID, email: "Guest@Example.com" }),
      makeLookup(),
    );

    // Must filter by church_group_id (tenant scoping), by the (lowercased)
    // invited email via a case-insensitive match, and must exclude
    // anonymized users — never a bare global email lookup that could leak
    // cross-tenant existence.
    expect(calls).toContainEqual({ method: "eq", args: ["church_group_id", CHURCH_GROUP_ID] });
    expect(calls).toContainEqual({ method: "ilike", args: ["email", "guest@example.com"] });
    expect(calls).toContainEqual({ method: "is", args: ["anonymized_at", null] });
  });

  it("escapes _ in the invited email before passing it to ilike, so it can't act as a wildcard", async () => {
    setUpAuth();
    const calls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return { select: jest.fn(() => makeRecordingChain({ data: serviceWeekRow, error: null })) };
        }
        if (table === "users") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: [], error: null }, (method, args) =>
                calls.push({ method, args }),
              ),
            ),
          };
        }
        throw new Error(`Unexpected table in this test: ${table}`);
      }),
      rpc: jest.fn(() => Promise.resolve({ data: null, error: { message: "EMAIL_TAKEN" } })),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    // "_" is legal in the local part of an email address and accepted by
    // createGuestInvitationSchema's z.string().email() (unlike "%" and "\",
    // which that validator already rejects) — it would otherwise become a
    // LIKE wildcard matching unrelated rows if passed through unescaped.
    await createGuestInvitation(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID, email: "under_score@example.com" }),
      makeLookup(),
    );

    expect(calls).toContainEqual({
      method: "ilike",
      args: ["email", "under\\_score@example.com"],
    });
  });

  it("an email belonging to a user in a DIFFERENT group is invisible to the existing-user lookup and falls through to the new-user (provisioning) branch", async () => {
    setUpAuth();
    const rpc = jest.fn(() =>
      Promise.resolve({
        data: {
          id: "provisioned-1",
          clerk_id: "pending_guest_abc",
          church_group_id: OTHER_CHURCH_GROUP_ID,
          role: "guest",
          name: "guest",
          email: "cross-tenant@example.com",
        },
        error: null,
      }),
    );

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({
                data: { ...serviceWeekRow, church_group_id: OTHER_CHURCH_GROUP_ID },
                error: null,
              }),
            ),
          };
        }
        if (table === "users") {
          // A real church_group_id-scoped query would return zero rows for
          // an email that belongs to a user in a different group.
          return { select: jest.fn(() => makeRecordingChain({ data: [], error: null })) };
        }
        if (table === "invitations") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: [], error: null })),
            insert: jest.fn(() =>
              makeRecordingChain({
                data: {
                  id: "invitation-x",
                  church_group_id: OTHER_CHURCH_GROUP_ID,
                  service_week_id: SERVICE_WEEK_ID,
                  user_id: "provisioned-1",
                  role_note: null,
                  status: "pending",
                  response_token: "c".repeat(64),
                  response_deadline: "2026-07-15T00:00:00Z",
                  invited_by: USER_ID,
                  created_at: "2026-07-12T00:00:00Z",
                },
                error: null,
              }),
            ),
          };
        }
        if (table === "audit_logs") {
          return { insert: jest.fn(() => makeRecordingChain({ data: null, error: null })) };
        }
        throw new Error(`Unexpected table in this test: ${table}`);
      }),
      rpc,
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID, email: "cross-tenant@example.com" }),
      makeLookup(OTHER_CHURCH_GROUP_ID),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.isNewUser).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "provision_guest_user",
      expect.objectContaining({ p_email: "cross-tenant@example.com" }),
    );
  });

  it("propagates provision_guest_user's global EMAIL_TAKEN as 409, never a 500, when the email belongs to a different-group user (no cross-tenant leak)", async () => {
    setUpAuth();
    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return { select: jest.fn(() => makeRecordingChain({ data: serviceWeekRow, error: null })) };
        }
        if (table === "users") {
          return { select: jest.fn(() => makeRecordingChain({ data: [], error: null })) };
        }
        throw new Error(`Unexpected table in this test: ${table}`);
      }),
      rpc: jest.fn(() => Promise.resolve({ data: null, error: { message: "EMAIL_TAKEN" } })),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID, email: "someone-elses-email@example.com" }),
      makeLookup(),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    // The error message must not reveal which group (or that any group at
    // all) already owns the email.
    expect(body.error.toLowerCase()).not.toContain("group");
  });
});
