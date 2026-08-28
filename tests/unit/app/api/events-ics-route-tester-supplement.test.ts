// Tester supplement for #63 (iCal export fallback — route handlers).
//
// The coder's own tests/unit/app/api/events-ics-route.test.ts already covers
// 401/404/400/500/200 paths for both endpoints. This file independently
// verifies three things named as focus areas in the coder's own
// .pipeline/changes.md that the coder's suite does not directly prove:
//
//   1. Attendee-scoping distinction: the handlers must consult
//      `event_attendees` (the #60 attendee model), NEVER the
//      invitation-scoped `invitations` table used by GET /api/events. A
//      caller with an invitation to the service week but no event_attendees
//      row must still get 404. We assert this by spying on every table name
//      passed to `supabase.from(...)` and confirming "invitations" is never
//      queried by either endpoint, even when invitation data is present.
//   2. Escaping/folding correctness end-to-end through the full handler
//      (DB row -> IcalEventInput -> generateIcs), not just the pure
//      generator in isolation, using a `notes` value with `,` `;` `\` and
//      embedded newlines, and a long `notes` value that must fold.
//   3. A genuine failure case beyond "Supabase returned an error object":
//      a malformed `start_time` that makes `new Date(...).toISOString()`
//      throw inside the try/catch must surface as 500 INTERNAL, not an
//      unhandled exception or a 200 with garbage content.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { exportEventIcs } from "@/app/api/events/[id]/ics/handler";
import { exportEventsIcs } from "@/app/api/events/ics/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHURCH_GROUP_ID = "group-1";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";

function makeReq(searchParams: Record<string, string> = {}): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(undefined),
    nextUrl: { searchParams: new URLSearchParams(searchParams) },
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "member" };
  return async () => ctx;
}

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue("supabase-jwt"),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

type QueryResult = { data: unknown; error: unknown };

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    order: jest.fn(() => Promise.resolve(result)),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

describe("tester supplement: attendee-scoping distinction (never touches invitations table)", () => {
  it("GET /api/events/:id/ics never queries 'invitations', even conceptually available", async () => {
    setUpAuth();
    const fromCalls: string[] = [];
    const client = {
      from: jest.fn((table: string) => {
        fromCalls.push(table);
        if (table === "event_attendees") {
          // Caller is NOT an assigned attendee (but, in a real DB, could
          // still hold an invitation to the event's service week — that
          // must not matter here).
          return { select: jest.fn(() => makeChain({ data: null, error: null })) };
        }
        if (table === "invitations") {
          // If the handler ever queried this (it must not), give it data
          // that would wrongly grant access, to make a regression loud.
          return {
            select: jest.fn(() => makeChain({ data: [{ service_week_id: "sw-1" }], error: null })),
          };
        }
        return { select: jest.fn(() => makeChain({ data: null, error: null })) };
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());

    expect(res.status).toBe(404);
    expect(fromCalls).not.toContain("invitations");
    expect(fromCalls).toContain("event_attendees");
  });

  it("GET /api/events/ics never queries 'invitations', even conceptually available", async () => {
    setUpAuth();
    const fromCalls: string[] = [];
    const client = {
      from: jest.fn((table: string) => {
        fromCalls.push(table);
        if (table === "event_attendees") {
          return { select: jest.fn(() => makeChain({ data: [], error: null })) };
        }
        if (table === "invitations") {
          return {
            select: jest.fn(() => makeChain({ data: [{ service_week_id: "sw-1" }], error: null })),
          };
        }
        return { select: jest.fn(() => makeChain({ data: null, error: null })) };
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await exportEventsIcs(makeReq(), makeLookup());

    expect(res.status).toBe(404);
    expect(fromCalls).not.toContain("invitations");
    expect(fromCalls).toContain("event_attendees");
  });
});

describe("tester supplement: escaping/folding end-to-end through the real handler", () => {
  it("escapes special characters in name/location/notes fetched from the DB", async () => {
    setUpAuth();
    const eventRow = {
      id: EVENT_ID,
      name: 'Rehearsal, "big" show; final\\draft',
      location: "Room A, Wing B; note\\path",
      notes: "line1\nline2\r\nline3, with; commas\\and backslashes",
      start_time: "2026-07-12T09:00:00.000Z",
      end_time: "2026-07-12T11:00:00.000Z",
    };
    const client = {
      from: jest.fn((table: string) => {
        if (table === "event_attendees") {
          return { select: jest.fn(() => makeChain({ data: { id: "attendee-1" }, error: null })) };
        }
        if (table === "events") {
          return { select: jest.fn(() => makeChain({ data: eventRow, error: null })) };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(200);

    const body = await res.text();
    // Escaped forms must appear; the raw unescaped separators must not
    // appear unescaped inside the property values.
    expect(body).toContain("SUMMARY:Rehearsal\\, \"big\" show\\; final\\\\draft");
    expect(body).toContain("LOCATION:Room A\\, Wing B\\; note\\\\path");
    expect(body).toContain("DESCRIPTION:line1\\nline2\\nline3\\, with\\; commas\\\\and backslashes");
  });

  it("folds a genuinely long notes value end-to-end (schema allows unbounded length)", async () => {
    setUpAuth();
    const longNotes = "Reminder: bring in-ears and extra cables. ".repeat(20); // > 75 octets
    const eventRow = {
      id: EVENT_ID,
      name: "Full band rehearsal",
      location: "Main hall",
      notes: longNotes,
      start_time: "2026-07-12T09:00:00.000Z",
      end_time: "2026-07-12T11:00:00.000Z",
    };
    const client = {
      from: jest.fn((table: string) => {
        if (table === "event_attendees") {
          return { select: jest.fn(() => makeChain({ data: { id: "attendee-1" }, error: null })) };
        }
        if (table === "events") {
          return { select: jest.fn(() => makeChain({ data: eventRow, error: null })) };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(200);

    const body = await res.text();
    const lines = body.split("\r\n");

    const descIndex = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
    expect(descIndex).toBeGreaterThanOrEqual(0);
    // Must actually be folded (a continuation line follows).
    expect(lines[descIndex + 1]?.startsWith(" ")).toBe(true);

    // Every physical line in the whole document (not just DESCRIPTION) must
    // respect the 75-octet content-line limit end-to-end.
    for (const line of lines) {
      if (line === "") continue;
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});

describe("tester supplement: genuine failure case beyond a Supabase error object", () => {
  it("returns 500 INTERNAL (not an unhandled exception or 200) when start_time is not a parseable date", async () => {
    setUpAuth();
    const eventRow = {
      id: EVENT_ID,
      name: "Broken event",
      location: null,
      notes: null,
      start_time: "not-a-real-date",
      end_time: "2026-07-12T11:00:00.000Z",
    };
    const client = {
      from: jest.fn((table: string) => {
        if (table === "event_attendees") {
          return { select: jest.fn(() => makeChain({ data: { id: "attendee-1" }, error: null })) };
        }
        if (table === "events") {
          return { select: jest.fn(() => makeChain({ data: eventRow, error: null })) };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    // This must not throw out of the handler — it should be caught and
    // turned into a well-formed 500 response, exactly like any other
    // internal failure.
    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
