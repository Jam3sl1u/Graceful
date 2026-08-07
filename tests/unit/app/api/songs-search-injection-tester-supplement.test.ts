// Tester-stage supplemental coverage for issue #77 Change 1: the escaped
// PostgREST filter in GET /api/songs (listSongs). Independent of the
// Coder's tests/unit/app/api/songs-route.test.ts — focuses on adversarial
// `q` values that could break out of the `.or(...)` filter grammar if left
// unescaped (`,` `(` `)` `.` `"` `\`).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { listSongs } from "@/app/api/songs/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(query: Record<string, string> = {}): NextRequest {
  const searchParams = new URLSearchParams(query);
  return {
    nextUrl: { searchParams },
    json: jest.fn().mockResolvedValue(undefined),
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role };
  return async () => ctx;
}

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(JWT),
  });
}

type QueryResult = { data: unknown; error: unknown };

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(selectResult: QueryResult = { data: [], error: null }) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => makeChain(selectResult)),
    })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/songs — adversarial q values (PostgREST filter injection, issue #77)", () => {
  it.each([
    ["comma (multi-clause breakout)", "amaz,and(status.eq.deleted"],
    ["parens (nested filter breakout)", "amaz)or(id.neq.0"],
    ["dot (operator breakout)", "amaz.eq.foo"],
    ["double quote (closes the quoted term early)", 'amaz"or(1.eq.1'],
    ["backslash", "amaz\\ing"],
    ["combination of all reserved characters", 'a,b(c).d"e\\f'],
  ])("escapes %s so the .or() call receives a single safely-quoted term", async (_label, q) => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listSongs(makeReq({ q }), makeLookup("member"));
    expect(res.status).toBe(200);

    const fromResult = client.from.mock.results[0]!.value;
    const selectChain = fromResult.select.mock.results[0]!.value;

    // .or() must be called exactly once, with a single string argument: no
    // extra top-level comma-separated clause has leaked in from `q`.
    expect(selectChain.or).toHaveBeenCalledTimes(1);
    const [filterArg] = selectChain.or.mock.calls[0] as [string];
    expect(typeof filterArg).toBe("string");

    // The filter string must still be exactly the two expected ilike terms,
    // each wrapped in double quotes — i.e. the raw q never appears
    // unescaped/unquoted inside the filter string.
    const match = filterArg.match(
      /^title\.ilike\."%(.*)%",artist\.ilike\."%(.*)%"$/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toBe(match![2]);

    // Escaped backslashes then quotes: reversing the escaping must recover
    // the original q exactly, and the quoted term must contain a properly
    // balanced (escaped) set of quotes -- i.e. an even number of unescaped
    // '"' does not occur mid-term.
    const escaped = match![1]!;
    const unescaped = escaped.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    expect(unescaped).toBe(q);
  });

  it("does not let a crafted q register additional top-level filter clauses beyond title/artist ilike", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    // A `q` that, unescaped, would read as:
    //   title.ilike.%x%,artist.ilike.%x%,is_deleted.eq.false
    // i.e. an attempt to smuggle in a third clause via a raw comma.
    const q = "x%,is_deleted.eq.false";
    await listSongs(makeReq({ q }), makeLookup("member"));

    const fromResult = client.from.mock.results[0]!.value;
    const selectChain = fromResult.select.mock.results[0]!.value;
    const [filterArg] = selectChain.or.mock.calls[0] as [string];

    // Only two top-level clauses (one comma outside of any quoted term).
    // Splitting naively on `,` and counting occurrences of `.ilike.` shows
    // there are exactly two ilike clauses, not three.
    const ilikeOccurrences = (filterArg.match(/\.ilike\./g) ?? []).length;
    expect(ilikeOccurrences).toBe(2);
    expect(filterArg).not.toContain("is_deleted.eq.false\",");
  });

  it("preserves plain, non-adversarial q values unchanged (no false-positive escaping)", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    await listSongs(makeReq({ q: "amazing grace" }), makeLookup("member"));

    const fromResult = client.from.mock.results[0]!.value;
    const selectChain = fromResult.select.mock.results[0]!.value;
    expect(selectChain.or).toHaveBeenCalledWith(
      'title.ilike."%amazing grace%",artist.ilike."%amazing grace%"',
    );
  });
});
