// Consolidated auth-matrix pass (issue #32 T3) — a dedicated test pass over
// the admin-gated, handler-style Sprint-1 routes, written against the shared
// harness in tests/support/api-auth.ts to demonstrate it is reusable. This
// complements, and does not replace, the deep per-route test files.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { mockClerkAuthed, mockClerkAnonymous, makeLookup, makeJsonReq } from "@/tests/support/api-auth";
import type { UserLookup } from "@/lib/api/auth";
import { patchMemberRole } from "@/app/api/church-group/members/[id]/role/handler";
import { getAuditLog } from "@/app/api/church-group/audit-log/handler";
import {
  addInstrument,
  promoteInstrument,
  deleteInstrument,
} from "@/app/api/instruments/handler";
import { getChurchGroupMembers } from "@/app/api/church-group/members/handler";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const fakeReq = {} as NextRequest;

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("patchMemberRole (#27)", () => {
  const TARGET_ID = "22222222-2222-2222-2222-222222222222";

  // Minimal chainable query-builder mock, plus rpc() for writeAuditLog.
  // Mirrors tests/unit/app/api/church-group-members-role-route.test.ts.
  function makeQueryBuilder(result: QueryResult) {
    const builder: PromiseLike<QueryResult> & Record<string, jest.Mock> = {
      select: jest.fn(() => builder),
      eq: jest.fn(() => builder),
      update: jest.fn(() => builder),
      maybeSingle: jest.fn(() => Promise.resolve(result)),
      then: ((resolve: (value: QueryResult) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject)) as never,
    } as unknown as PromiseLike<QueryResult> & Record<string, jest.Mock>;
    return builder;
  }

  function makeSupabaseClient(queue: QueryResult[]) {
    const results = [...queue];
    const from = jest.fn(() => makeQueryBuilder(results.shift() ?? { data: null, error: null }));
    const rpc = jest.fn().mockResolvedValue({ error: null });
    return { from, rpc };
  }

  it("unauth -> 401 UNAUTHENTICATED (lookup never consulted)", async () => {
    mockClerkAnonymous();
    const lookup = jest.fn();

    const res = await patchMemberRole(
      makeJsonReq({ role: "member" }),
      TARGET_ID,
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("member -> 403 FORBIDDEN", async () => {
    mockClerkAuthed();

    const res = await patchMemberRole(
      makeJsonReq({ role: "admin" }),
      TARGET_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("malformed body -> 400 VALIDATION_FAILED", async () => {
    mockClerkAuthed();

    const res = await patchMemberRole(makeJsonReq(null), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("admin success -> 200", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "member" }, error: null }, // target lookup
        { data: { id: TARGET_ID, role: "admin" }, error: null }, // update
      ]),
    );

    const res = await patchMemberRole(
      makeJsonReq({ role: "admin" }),
      TARGET_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: TARGET_ID, role: "admin" });
  });
});

describe("getAuditLog (#29)", () => {
  // Mirrors tests/unit/app/api/audit-log-route.test.ts.
  function makeAuditReq(query: Record<string, string> = {}): NextRequest {
    const searchParams = new URLSearchParams(query);
    return { nextUrl: { searchParams } } as unknown as NextRequest;
  }

  function makeSupabaseClient(result: QueryResult = { data: [], error: null, count: 0 }) {
    const range = jest.fn().mockResolvedValue(result);
    const order2 = jest.fn(() => ({ range }));
    const order1 = jest.fn(() => ({ order: order2 }));
    const select = jest.fn(() => ({ order: order1 }));
    const from = jest.fn(() => ({ select }));
    return { from };
  }

  it("unauth -> 401 UNAUTHENTICATED (lookup never consulted)", async () => {
    mockClerkAnonymous();
    const lookup = jest.fn();

    const res = await getAuditLog(makeAuditReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("member -> 403 FORBIDDEN", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getAuditLog(makeAuditReq(), makeLookup("member"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("admin success -> 200", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: [], error: null, count: 0 }),
    );

    const res = await getAuditLog(makeAuditReq(), makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entries).toEqual([]);
  });
});

describe("addInstrument (#31)", () => {
  // Mirrors tests/unit/app/api/instruments-route.test.ts.
  function makeChain(result: QueryResult) {
    const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
      eq: jest.fn(() => chain),
      select: jest.fn(() => chain),
      single: jest.fn(() => Promise.resolve(result)),
      then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
    return chain;
  }

  function makeSupabaseClient(fixtures: { select?: QueryResult; insert?: QueryResult } = {}) {
    const selectResult = fixtures.select ?? { data: [], error: null };
    const insertResult = fixtures.insert ?? {
      data: { id: "instr-new", name: "Trumpet", is_default: true, created_by: "user-1" },
      error: null,
    };
    return {
      from: jest.fn(() => ({
        select: jest.fn(() => makeChain(selectResult)),
        insert: jest.fn(() => makeChain(insertResult)),
      })),
    };
  }

  it("unauth -> 401 UNAUTHENTICATED (lookup never consulted)", async () => {
    mockClerkAnonymous();
    const lookup = jest.fn();

    const res = await addInstrument(makeJsonReq({ name: "Trumpet" }), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("member -> 403 FORBIDDEN", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await addInstrument(makeJsonReq({ name: "Trumpet" }), makeLookup("member"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("malformed body -> 400 VALIDATION_FAILED", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await addInstrument(makeJsonReq(null), makeLookup("admin"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("admin success -> 201", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ select: { data: [], error: null } }),
    );

    const res = await addInstrument(makeJsonReq({ name: "Trumpet" }), makeLookup("admin"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.instrument.isDefault).toBe(true);
  });
});

describe("promoteInstrument (#31)", () => {
  // Mirrors tests/unit/app/api/instruments-route.test.ts.
  function makeChain(result: QueryResult) {
    const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
      eq: jest.fn(() => chain),
      select: jest.fn(() => chain),
      then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
    return chain;
  }

  function makeSupabaseClient(updateResult: QueryResult = {
    data: [{ id: "instr-1", name: "Kazoo", is_default: true, created_by: "user-2" }],
    error: null,
  }) {
    return {
      from: jest.fn(() => ({
        update: jest.fn(() => makeChain(updateResult)),
      })),
    };
  }

  it("unauth -> 401 UNAUTHENTICATED (lookup never consulted)", async () => {
    mockClerkAnonymous();
    const lookup = jest.fn();

    const res = await promoteInstrument(fakeReq, "instr-1", lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("member -> 403 FORBIDDEN", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await promoteInstrument(fakeReq, "instr-1", makeLookup("member"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("admin success -> 200", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await promoteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.instrument.isDefault).toBe(true);
  });
});

describe("deleteInstrument (#31)", () => {
  // Mirrors tests/unit/app/api/instruments-route.test.ts.
  function makeChain(result: QueryResult) {
    const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
      eq: jest.fn(() => chain),
      select: jest.fn(() => chain),
      then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
    return chain;
  }

  function makeSupabaseClient(deleteResult: QueryResult = { data: [{ id: "instr-1" }], error: null }) {
    return {
      from: jest.fn(() => ({
        delete: jest.fn(() => makeChain(deleteResult)),
      })),
    };
  }

  it("unauth -> 401 UNAUTHENTICATED (lookup never consulted)", async () => {
    mockClerkAnonymous();
    const lookup = jest.fn();

    const res = await deleteInstrument(fakeReq, "instr-1", lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("member -> 403 FORBIDDEN", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteInstrument(fakeReq, "instr-1", makeLookup("member"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("admin success -> 200 { deleted: true }", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
  });
});

describe("getChurchGroupMembers (#26, admin-vs-guest gating)", () => {
  // Mirrors tests/unit/app/api/church-group-members-route.test.ts.
  const usersRows = [
    { id: "user-1", name: "Caller Admin", role: "admin", email: "admin@example.com", phone: "555-0001" },
  ];

  function makeSupabaseClient(overrides: Partial<Record<string, QueryResult>> = {}) {
    const fixtures: Record<string, QueryResult> = {
      users: { data: usersRows, error: null },
      member_profiles: { data: [], error: null },
      member_instruments: { data: [], error: null },
      instruments: { data: [], error: null },
      ...overrides,
    };

    const eqMock = jest.fn();
    const isMock = jest.fn();

    return {
      from: jest.fn((table: string) => ({
        select: jest.fn(() => {
          const result = fixtures[table];
          const chain = Promise.resolve(result) as Promise<QueryResult> & {
            eq: jest.Mock;
            is: jest.Mock;
          };
          chain.eq = eqMock.mockImplementation(() => {
            const eqChain = Promise.resolve(result) as Promise<QueryResult> & { is: jest.Mock };
            eqChain.is = isMock.mockImplementation(() => Promise.resolve(result));
            return eqChain;
          });
          chain.is = isMock;
          return chain;
        }),
      })),
    };
  }

  it("unauth -> 401 UNAUTHENTICATED (lookup never consulted)", async () => {
    mockClerkAnonymous();
    const lookup = jest.fn();

    const res = await getChurchGroupMembers(fakeReq, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("guest -> 403 FORBIDDEN", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("admin success -> 200", async () => {
    mockClerkAuthed();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getChurchGroupMembers(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.members).toHaveLength(1);
  });
});
