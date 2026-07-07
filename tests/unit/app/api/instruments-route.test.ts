jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  listInstruments,
  addInstrument,
  submitCustomInstrument,
  promoteInstrument,
  deleteInstrument,
  type InstrumentResponse,
} from "@/app/api/instruments/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

const fakeReq = {} as NextRequest;

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role,
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
type TableFixture = {
  select?: QueryResult;
  insert?: QueryResult;
  update?: QueryResult;
  delete?: QueryResult;
};

const defaultInstrumentsRows = [
  { id: "instr-default", name: "Piano", is_default: true, created_by: null },
  { id: "instr-custom", name: "Kazoo", is_default: false, created_by: "user-2" },
];

const DEFAULT_FIXTURES: Record<string, Required<TableFixture>> = {
  instruments: {
    select: { data: defaultInstrumentsRows, error: null },
    insert: {
      data: { id: "instr-new", name: "Trumpet", is_default: true, created_by: USER_ID },
      error: null,
    },
    update: {
      data: [{ id: "instr-1", name: "Kazoo", is_default: true, created_by: "user-2" }],
      error: null,
    },
    delete: { data: [{ id: "instr-1" }], error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).order(...).order(...)      (list)
//   .select(...).eq(...)                             (duplicate-guard read)
//   .insert(...).select(...).single()
//   .update(...).eq(...).eq(...).select(...)
//   .delete().eq(...).eq(...).select(...)
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(
  overrides: Partial<Record<string, TableFixture>> = {},
  hooks?: {
    onInsert?: (table: string, payload: unknown) => void;
    onUpdate?: (table: string, payload: unknown) => void;
  },
) {
  const fixtures: Record<string, Required<TableFixture>> = {};
  for (const table of Object.keys(DEFAULT_FIXTURES)) {
    const base = DEFAULT_FIXTURES[table]!;
    const override = overrides[table] ?? {};
    fixtures[table] = {
      select: override.select ?? base.select,
      insert: override.insert ?? base.insert,
      update: override.update ?? base.update,
      delete: override.delete ?? base.delete,
    };
  }

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table]!;
      return {
        select: jest.fn(() => makeChain(tableFixture.select)),
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert);
        }),
        update: jest.fn((payload: unknown) => {
          hooks?.onUpdate?.(table, payload);
          return makeChain(tableFixture.update);
        }),
        delete: jest.fn(() => makeChain(tableFixture.delete)),
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/instruments", () => {
  it("returns 200 with instruments mapped and pending flag correct for default vs custom rows", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listInstruments(fakeReq, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const instruments: InstrumentResponse[] = body.data.instruments;
    expect(instruments).toEqual([
      { id: "instr-default", name: "Piano", isDefault: true, pending: false, createdBy: null },
      { id: "instr-custom", name: "Kazoo", isDefault: false, pending: true, createdBy: "user-2" },
    ]);
  });

  it("returns 200 with an empty array when the group has no instruments", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ instruments: { select: { data: [], error: null } } }),
    );

    const res = await listInstruments(fakeReq, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.instruments).toEqual([]);
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await listInstruments(fakeReq, makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listInstruments(fakeReq, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/instruments (admin add)", () => {
  it("returns 201 and sets is_default: true", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { instruments: { select: { data: [], error: null } } }, // no existing duplicates
        { onInsert: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await addInstrument(makeReq({ name: "Trumpet" }), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const instrument: InstrumentResponse = body.data.instrument;
    expect(instrument.isDefault).toBe(true);
    expect(instrument.pending).toBe(false);
    expect(capturedPayload).toMatchObject({
      church_group_id: CHURCH_GROUP_ID,
      name: "Trumpet",
      is_default: true,
      created_by: USER_ID,
    });
  });

  it("returns 403 FORBIDDEN for a non-admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await addInstrument(makeReq({ name: "Trumpet" }), makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for an empty/whitespace-only name", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await addInstrument(makeReq({ name: "   " }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a missing/malformed body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await addInstrument(makeReq(null), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a name longer than 100 chars (matches varchar(100))", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await addInstrument(makeReq({ name: "A".repeat(101) }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("accepts a name that is exactly 100 chars", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { instruments: { select: { data: [], error: null } } },
        { onInsert: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await addInstrument(makeReq({ name: "A".repeat(100) }), makeLookup("admin"));
    expect(res.status).toBe(201);
    expect(capturedPayload).toMatchObject({ name: "A".repeat(100) });
  });

  it("returns 409 CONFLICT for a case-insensitive duplicate name", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: { select: { data: [{ name: "trumpet" }], error: null } },
      }),
    );

    const res = await addInstrument(makeReq({ name: "Trumpet" }), makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await addInstrument(makeReq({ name: "Trumpet" }), makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: {
          select: { data: [], error: null },
          insert: { data: null, error: { message: "constraint violation" } },
        },
      }),
    );

    const res = await addInstrument(makeReq({ name: "Trumpet" }), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/instruments/custom (member submit)", () => {
  it("returns 201, sets is_default: false, and is allowed for a plain member", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          instruments: {
            select: { data: [], error: null },
            insert: {
              data: {
                id: "instr-new-custom",
                name: "Kazoo",
                is_default: false,
                created_by: USER_ID,
              },
              error: null,
            },
          },
        },
        { onInsert: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await submitCustomInstrument(makeReq({ name: "Kazoo" }), makeLookup("member"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const instrument: InstrumentResponse = body.data.instrument;
    expect(instrument.isDefault).toBe(false);
    expect(instrument.pending).toBe(true);
    expect(capturedPayload).toMatchObject({
      church_group_id: CHURCH_GROUP_ID,
      name: "Kazoo",
      is_default: false,
      created_by: USER_ID,
    });
  });

  it("returns 400 VALIDATION_FAILED for an empty name", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await submitCustomInstrument(makeReq({ name: "" }), makeLookup("member"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 409 CONFLICT for a case-insensitive duplicate name", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: { select: { data: [{ name: "KAZOO" }], error: null } },
      }),
    );

    const res = await submitCustomInstrument(makeReq({ name: "kazoo" }), makeLookup("member"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await submitCustomInstrument(makeReq({ name: "Kazoo" }), makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: {
          select: { data: [], error: null },
          insert: { data: null, error: { message: "constraint violation" } },
        },
      }),
    );

    const res = await submitCustomInstrument(makeReq({ name: "Kazoo" }), makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the duplicate-guard read errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await submitCustomInstrument(makeReq({ name: "Kazoo" }), makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/instruments/[id]/promote (admin)", () => {
  it("returns 200 and sets is_default: true", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onUpdate: (table, payload) => (capturedPayload = payload) }),
    );

    const res = await promoteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const instrument: InstrumentResponse = body.data.instrument;
    expect(instrument.isDefault).toBe(true);
    expect(instrument.pending).toBe(false);
    expect(capturedPayload).toEqual({ is_default: true });
  });

  it("returns 404 NOT_FOUND when the id does not match any row in the group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ instruments: { update: { data: [], error: null } } }),
    );

    const res = await promoteInstrument(fakeReq, "missing-id", makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 403 FORBIDDEN for a non-admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await promoteInstrument(fakeReq, "instr-1", makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the update errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: { update: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await promoteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("DELETE /api/instruments/[id] (admin)", () => {
  it("returns 200 { deleted: true }", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
  });

  it("returns 404 NOT_FOUND when the id does not match any row in the group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ instruments: { delete: { data: [], error: null } } }),
    );

    const res = await deleteInstrument(fakeReq, "missing-id", makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 403 FORBIDDEN for a non-admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteInstrument(fakeReq, "instr-1", makeLookup("set_leader"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await deleteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the delete errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        instruments: { delete: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await deleteInstrument(fakeReq, "instr-1", makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
