// Full auth-bypass sweep across every exported route handler (issue #80,
// AC-1). Sister file to tests/unit/app/api/auth-matrix.test.ts (#32), which
// predates this and covers a 5-handler subset with only unauth/member/admin
// cases; this file is exhaustive (see tests/support/admin-route-registry.ts,
// the single source of truth for the sweep) and additionally covers
// expired-token and cross-tenant-admin cases that file does not.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: jest.fn(),
  getAnonSupabaseClient: jest.fn(),
}));
// next/headers is used by the google-calendar callback/connect handlers
// (cookies() for CSRF state) — not itself a side-effecting external client,
// but importing ~19 handler modules must not depend on a real Next.js
// request context existing.
jest.mock("next/headers", () => ({ cookies: jest.fn() }));
// Side-effecting external clients pulled in at import time by registry
// handler modules — mocked so importing them in one file cannot fail on
// missing env, per spec.
jest.mock("@/lib/r2/client", () => ({ getUploadUrl: jest.fn(), getDownloadUrl: jest.fn() }));
jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ sendEmail: jest.fn() }));
jest.mock("@/lib/upstash/qstash", () => ({
  scheduleReminder: jest.fn(),
  cancelReminder: jest.fn(),
}));
jest.mock("@/lib/upstash/redis", () => ({
  enqueueTranscriptionJob: jest.fn(),
  getQueuePosition: jest.fn(),
}));
jest.mock("@/lib/spotify/client", () => ({ lookupTrack: jest.fn() }));
jest.mock("@/lib/google-calendar/oauth", () => ({
  getAuthUrl: jest.fn(),
  exchangeCode: jest.fn(),
  refreshAccessToken: jest.fn(),
  revokeToken: jest.fn(),
}));
jest.mock("@/lib/google-calendar/sync", () => ({
  toGoogleEventId: jest.fn(),
  syncEventToAttendees: jest.fn(),
  unsyncEventFromAttendees: jest.fn(),
  syncEventToUser: jest.fn(),
  unsyncEventFromUser: jest.fn(),
  syncAllEventsForUser: jest.fn(),
}));
jest.mock("@/lib/google-calendar/token-crypto", () => ({
  encryptToken: jest.fn(),
  decryptToken: jest.fn(),
}));

import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { getSupabaseClient, getAnonSupabaseClient } from "@/lib/supabase/client";
import { exchangeCode } from "@/lib/google-calendar/oauth";
import { syncAllEventsForUser } from "@/lib/google-calendar/sync";
import type { UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";
import {
  mockClerkAuthed,
  mockClerkAnonymous,
  makeLookup,
  makeNullLookup,
  makeApiReq,
  DEFAULT_CHURCH_GROUP_ID,
  DEFAULT_USER_ID,
  VICTIM_CHURCH_GROUP_ID,
  VICTIM_USER_ID,
} from "@/tests/support/api-auth";
import { makeRecordingSupabase } from "@/tests/support/recording-supabase";
import { ADMIN_ROUTE_REGISTRY } from "@/tests/support/admin-route-registry";

import { claimGuestInvitation } from "@/app/api/invitations/handler";
import { PUT as churchGroupPut } from "@/app/api/church-group/route";
import { POST as churchGroupJoinPost } from "@/app/api/church-group/join/route";
import { GET as cronInvitationRemindersGet } from "@/app/api/cron/invitation-reminders/route";

const mockAuth = auth as unknown as jest.Mock;
const mockCurrentUser = currentUser as unknown as jest.Mock;
const mockCookies = cookies as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;
const mockExchangeCode = exchangeCode as unknown as jest.Mock;
const mockSyncAllEventsForUser = syncAllEventsForUser as unknown as jest.Mock;

// CSRF state value the google-calendar/callback registry entry's request
// carries — must match what the mocked cookie store returns below so a
// valid-admin invocation gets far enough to actually touch the DB (case 4).
const CALLBACK_STATE = "csrf-state-value";

beforeEach(() => {
  mockAuth.mockReset();
  mockCurrentUser.mockReset().mockResolvedValue(null);
  mockGetSupabaseClient.mockReset();
  mockGetAnonSupabaseClient.mockReset();
  mockExchangeCode.mockReset().mockResolvedValue({
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiryDate: "2026-08-01T00:00:00.000Z",
    scope: "https://www.googleapis.com/auth/calendar.events",
  });
  mockSyncAllEventsForUser.mockReset().mockResolvedValue(undefined);
  mockCookies.mockReset().mockResolvedValue({
    get: jest.fn(() => ({ value: CALLBACK_STATE })),
    set: jest.fn(),
    delete: jest.fn(),
  });
});

// Minimal shape for exercising the recording proxy's chain in the self-test
// below — the real client is `unknown` because its property set is dynamic
// (see tests/support/recording-supabase.ts).
type RecordingChain = {
  from: (table: string) => RecordingChain;
  select: (col: string) => RecordingChain;
  eq: (col: string, val: string) => RecordingChain;
  rpc: (name: string, args: unknown) => RecordingChain;
} & PromiseLike<unknown>;

// This double is itself non-obvious infrastructure (tests/support/
// recording-supabase.ts), so it gets its own self-test.
describe("makeRecordingSupabase (self-test)", () => {
  it("records a chained call and destructures like a real Supabase response", async () => {
    const recording = makeRecordingSupabase();
    const client = recording.client as RecordingChain;
    const result = await client.from("songs").select("id").eq("church_group_id", "g1");

    expect(recording.tables).toEqual(["songs"]);
    expect(recording.seenValues).toContain("g1");
    expect(result).toEqual({ data: [], error: null, count: 0 });
  });

  it("records .rpc() calls and flattens their args", async () => {
    const recording = makeRecordingSupabase({ data: { ok: true }, error: null });
    const client = recording.client as RecordingChain;
    const result = await client.rpc("do_thing", { p_id: "abc" });

    expect(recording.rpcs).toEqual(["do_thing"]);
    expect(recording.seenValues).toContain("abc");
    expect(recording.touched).toBe(true);
    expect(result).toEqual({ data: { ok: true }, error: null });
  });
});

describe.each(ADMIN_ROUTE_REGISTRY)("$name", (entry) => {
  const touchesSupabase = entry.touchesSupabase !== false;
  const ownScopeAssertion = entry.ownScopeAssertion !== false;

  if (entry.authFailureIsRedirect) {
    // Per-entry documented exception: this handler always responds with an
    // HTTP redirect, never JSON, on any auth failure (see the entry's
    // comment in tests/support/admin-route-registry.ts).
    it("no token -> redirect (never JSON)", async () => {
      mockClerkAnonymous();
      const lookup = jest.fn();

      const res = await entry.invoke(lookup as unknown as UserLookup);
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      expect(lookup).not.toHaveBeenCalled();
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("expired token (Clerk session ok, Supabase-template JWT lookup yields nothing) -> redirect (never JSON)", async () => {
      mockClerkAuthed();

      const res = await entry.invoke(makeNullLookup());
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("expired token (Clerk session present, getToken resolves null) -> redirect (never JSON)", async () => {
      mockClerkAuthed(null);

      const res = await entry.invoke(makeLookup("admin"));
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
    });
  } else {
    it("no token -> 401 UNAUTHENTICATED", async () => {
      mockClerkAnonymous();
      const lookup = jest.fn();

      const res = await entry.invoke(lookup as unknown as UserLookup);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("UNAUTHENTICATED");
      expect(lookup).not.toHaveBeenCalled();
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("expired token (Clerk session ok, Supabase-template JWT lookup yields nothing) -> 401 UNAUTHENTICATED", async () => {
      mockClerkAuthed();

      const res = await entry.invoke(makeNullLookup());
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("UNAUTHENTICATED");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    if (touchesSupabase) {
      it("expired token (Clerk session present, getToken resolves null) -> 401 UNAUTHENTICATED", async () => {
        mockClerkAuthed(null);

        const res = await entry.invoke(makeLookup("admin"));
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.code).toBe("UNAUTHENTICATED");
      });
    } else {
      // Documented exception (tests/support/admin-route-registry.ts,
      // touchesSupabase: false): this handler never re-fetches the
      // Supabase-template JWT on any code path, so there is nothing for a
      // resolves-null getToken() to break — the only auth check it performs
      // is requireAuth() itself, already covered by the two cases above.
      it("expired token (Clerk session present, getToken resolves null) -> handler does not use the Supabase JWT, so requireAuth alone governs", async () => {
        mockClerkAuthed(null);

        const res = await entry.invoke(makeLookup("admin"));
        expect(res.status).not.toBe(401);
      });
    }
  }

  if (entry.allowedRoles !== null) {
    const allowed = new Set(entry.allowedRoles);
    for (const role of ["member", "guest"] as UserRole[]) {
      if (allowed.has(role)) continue;

      it(`valid ${role} token, insufficient role -> 403 FORBIDDEN`, async () => {
        mockClerkAuthed();

        const res = await entry.invoke(makeLookup(role));
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.code).toBe("FORBIDDEN");
        expect(mockGetSupabaseClient).not.toHaveBeenCalled();
      });
    }
  }

  // Load-bearing assertion for cross-tenant admin: the app layer cannot 403
  // a foreign admin (they are a legitimate admin *of their own* group), so
  // the security property under test is that the handler derives its tenant
  // scope solely from the server-side AuthContext (ctx.churchGroupId /
  // ctx.userId) and never from caller-supplied ids.
  it("valid admin token from a different church group -> tenant scope comes from ctx, not the request", async () => {
    mockClerkAuthed();
    const recording = makeRecordingSupabase(entry.result);
    mockGetSupabaseClient.mockReturnValue(recording.client);
    mockGetAnonSupabaseClient.mockReturnValue(recording.client);

    const res = await entry.invoke(makeLookup("admin"));

    if (!touchesSupabase) {
      // Documented exception (touchesSupabase: false): no DB call is ever
      // made, so there is no tenant-scoped resource to leak from — just a
      // smoke check that the call still completes normally.
      expect(res.status).toBeLessThan(500);
      expect(recording.touched).toBe(false);
      return;
    }

    expect(recording.touched).toBe(true);
    // The negative assertion always applies, regardless of ownScopeAssertion.
    // makeApiReq (tests/support/api-auth.ts) injects VICTIM_CHURCH_GROUP_ID /
    // VICTIM_USER_ID into every request's query string (and body, when a
    // body object is present) under churchGroupId/church_group_id/userId/
    // user_id keys — so this is a live check for every entry that reaches
    // the DB layer, not just a check against strings no request ever
    // contains: a handler that echoed a caller-supplied scope id into the DB
    // layer would fail here.
    expect(recording.seenValues).not.toContain(VICTIM_CHURCH_GROUP_ID);
    expect(recording.seenValues).not.toContain(VICTIM_USER_ID);

    if (!ownScopeAssertion) {
      // Documented exception (ownScopeAssertion: false, see the entry's
      // comment in tests/support/admin-route-registry.ts) — tenant/user
      // scoping for this handler is enforced by RLS and/or a SECURITY
      // DEFINER RPC deriving identity from the JWT itself, never from a
      // value the handler passes as a literal argument.
      return;
    }

    if (entry.scope === "group") {
      expect(recording.seenValues).toContain(DEFAULT_CHURCH_GROUP_ID);
    } else {
      expect(recording.seenValues).toContain(DEFAULT_USER_ID);
    }
  });
});

// Non-registry routes: deliberately excluded from ADMIN_ROUTE_REGISTRY (see
// tests/support/admin-route-registry.ts) because they don't take a
// UserLookup — each gets its own explicitly-named coverage here instead.

describe("claimGuestInvitation (no lookup param — session-only)", () => {
  it("no Clerk session -> 401 UNAUTHENTICATED", async () => {
    mockClerkAnonymous();
    const res = await claimGuestInvitation(makeApiReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("Clerk session present, getToken resolves null -> 401 UNAUTHENTICATED", async () => {
    mockClerkAuthed(null);
    const res = await claimGuestInvitation(makeApiReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });
});

describe("PUT /api/church-group (no requireAuth — creator has no users row yet)", () => {
  it("no Clerk session -> 401 UNAUTHENTICATED", async () => {
    mockClerkAnonymous();
    const res = await churchGroupPut(makeApiReq({ body: { name: "Church", timezone: "UTC" } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("Clerk session present, getToken resolves null -> 401 UNAUTHENTICATED", async () => {
    mockClerkAuthed(null);
    const res = await churchGroupPut(makeApiReq({ body: { name: "Church", timezone: "UTC" } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });
});

describe("POST /api/church-group/join (no requireAuth — joiner has no users row yet)", () => {
  it("no Clerk session -> 401 UNAUTHENTICATED", async () => {
    mockClerkAnonymous();
    const res = await churchGroupJoinPost(makeApiReq({ body: { inviteCode: "CODE1234" } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("Clerk session present, getToken resolves null -> 401 UNAUTHENTICATED", async () => {
    mockClerkAuthed(null);
    const res = await churchGroupJoinPost(makeApiReq({ body: { inviteCode: "CODE1234" } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });
});

describe("GET /api/cron/invitation-reminders (CRON_SECRET bearer, not a Clerk session)", () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

  afterEach(() => {
    if (ORIGINAL_CRON_SECRET === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    }
  });

  it("no authorization header -> 401 UNAUTHENTICATED", async () => {
    process.env.CRON_SECRET = "the-real-secret";
    const res = await cronInvitationRemindersGet(makeApiReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("wrong bearer token -> 401 UNAUTHENTICATED", async () => {
    process.env.CRON_SECRET = "the-real-secret";
    const res = await cronInvitationRemindersGet(
      makeApiReq({ headers: { authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("CRON_SECRET unset -> 500 INTERNAL", async () => {
    delete process.env.CRON_SECRET;
    const res = await cronInvitationRemindersGet(
      makeApiReq({ headers: { authorization: "Bearer anything" } }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
