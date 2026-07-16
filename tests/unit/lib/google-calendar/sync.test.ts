// Tests for lib/google-calendar/sync.ts (#62 Google Calendar event sync).
// Mocks global.fetch (Google Calendar REST) and refreshAccessToken; uses the
// real token-crypto encrypt/decrypt round trip so SyncTarget rows look like
// real DB rows. `supabase` is a hand-rolled fake exposing only `.rpc` and
// `.from`, mirroring the route-handler test fixtures.

jest.mock("@/lib/google-calendar/oauth", () => {
  const actual = jest.requireActual("@/lib/google-calendar/oauth");
  return {
    ...actual,
    refreshAccessToken: jest.fn(),
  };
});

import { encryptToken } from "@/lib/google-calendar/token-crypto";
import { refreshAccessToken, GoogleTokenInvalidError } from "@/lib/google-calendar/oauth";
import {
  toGoogleEventId,
  syncEventToAttendees,
  unsyncEventFromAttendees,
  syncEventToUser,
  unsyncEventFromUser,
  syncAllEventsForUser,
  type CalendarEventInput,
} from "@/lib/google-calendar/sync";

const mockRefreshAccessToken = refreshAccessToken as unknown as jest.Mock;

const KEY = Buffer.alloc(32, 3).toString("base64");

type SyncTargetRow = {
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expiry: string;
  calendar_id: string;
};

function makeTarget(userId: string, overrides: Partial<SyncTargetRow> = {}): SyncTargetRow {
  return {
    user_id: userId,
    access_token_encrypted: encryptToken(`access-token-${userId}`),
    refresh_token_encrypted: encryptToken(`refresh-token-${userId}`),
    token_expiry: new Date(Date.now() + 3_600_000).toISOString(), // 1h out — not expired
    calendar_id: "primary",
    ...overrides,
  };
}

type RpcResult = { data?: unknown; error?: unknown };

function makeSupabase(options: {
  rpc?: Record<string, RpcResult | ((args: unknown) => RpcResult)>;
  eventAttendees?: { data: unknown; error: unknown };
  events?: { data: unknown; error: unknown };
}) {
  const rpcMock = jest.fn((fn: string, args?: unknown) => {
    const entry = options.rpc?.[fn];
    if (!entry) return Promise.resolve({ data: null, error: null });
    const result = typeof entry === "function" ? entry(args) : entry;
    return Promise.resolve(result);
  });

  const fromMock = jest.fn((table: string) => {
    if (table === "event_attendees") {
      const result = options.eventAttendees ?? { data: [], error: null };
      return { select: () => ({ eq: () => Promise.resolve(result) }) };
    }
    if (table === "events") {
      const result = options.events ?? { data: [], error: null };
      return { select: () => ({ in: () => Promise.resolve(result) }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return { rpc: rpcMock, from: fromMock };
}

const EVENT: CalendarEventInput = {
  googleEventId: "gr-event-1",
  name: "Full band rehearsal",
  location: "Main hall",
  notes: "Bring in-ears",
  startTime: "2026-07-12T09:00:00.000Z",
  endTime: "2026-07-12T11:00:00.000Z",
};

let fetchMock: jest.Mock;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockRefreshAccessToken.mockReset();
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("toGoogleEventId", () => {
  it("strips dashes, lowercases, and prefixes 'gr'", () => {
    expect(toGoogleEventId("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(
      "graaaaaaaabbbbccccddddeeeeeeeeeeee",
    );
  });

  it("is deterministic for the same input", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(toGoogleEventId(id)).toBe(toGoogleEventId(id));
  });
});

describe("syncEventToAttendees", () => {
  it("PATCHes every assigned attendee's calendar", async () => {
    const targets = [makeTarget("user-1"), makeTarget("user-2")];
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: targets, error: null } },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    expect(supabase.rpc).toHaveBeenCalledWith("get_event_sync_targets", { p_event_id: "event-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/gr-event-1",
    );
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-token-user-1" });
    expect(JSON.parse(init.body as string)).toEqual({
      summary: EVENT.name,
      location: EVENT.location,
      description: EVENT.notes,
      start: { dateTime: EVENT.startTime },
      end: { dateTime: EVENT.endTime },
    });
  });

  it("falls back to POST with the client-assigned id on a 404 PATCH", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [makeTarget("user-1")], error: null } },
    });
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 }) // PATCH
      .mockResolvedValueOnce({ ok: true, status: 200 }); // POST fallback

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toMatchObject({ id: "gr-event-1" });
  });

  it("isolates a per-attendee failure — one bad target never blocks another", async () => {
    const targets = [makeTarget("user-1"), makeTarget("user-2")];
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: targets, error: null } },
    });
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 }) // user-1 PATCH fails (outage)
      .mockResolvedValueOnce({ ok: true, status: 200 }); // user-2 PATCH succeeds

    await expect(syncEventToAttendees(supabase as never, "event-1", EVENT)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "flag_calendar_token_invalid",
      expect.anything(),
    );
  });

  it("flags the token invalid and notifies on a revoked refresh token (invalid_grant), without failing the caller", async () => {
    const expiredTarget = makeTarget("user-1", {
      token_expiry: new Date(Date.now() - 1000).toISOString(),
    });
    const supabase = makeSupabase({
      rpc: {
        get_event_sync_targets: { data: [expiredTarget], error: null },
        flag_calendar_token_invalid: { data: true, error: null },
      },
    });
    mockRefreshAccessToken.mockRejectedValue(new GoogleTokenInvalidError());

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith("flag_calendar_token_invalid", {
      p_user_id: "user-1",
    });
  });

  it("does not flag the token invalid on a non-auth failure (Google outage)", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [makeTarget("user-1")], error: null } },
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "flag_calendar_token_invalid",
      expect.anything(),
    );
  });

  it("never throws and makes no fetch calls when the RPC itself errors", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: null, error: { message: "db error" } } },
    });

    await expect(syncEventToAttendees(supabase as never, "event-1", EVENT)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses the stored access token without refreshing when it is not near expiry", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [makeTarget("user-1")], error: null } },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes the access token when it is expired, and uses the refreshed token", async () => {
    const expiredTarget = makeTarget("user-1", {
      token_expiry: new Date(Date.now() - 1000).toISOString(),
    });
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [expiredTarget], error: null } },
    });
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "refreshed-access-token",
      expiryDate: new Date(Date.now() + 3_600_000).toISOString(),
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    expect(mockRefreshAccessToken).toHaveBeenCalledWith("refresh-token-user-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer refreshed-access-token" });
  });
});

describe("unsyncEventFromAttendees", () => {
  it("DELETEs the event from every assigned attendee's calendar", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [makeTarget("user-1")], error: null } },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await unsyncEventFromAttendees(supabase as never, "event-1", "gr-event-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/gr-event-1",
    );
    expect(init.method).toBe("DELETE");
  });

  it.each([404, 410])("treats a %d response as success (already gone)", async (status) => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [makeTarget("user-1")], error: null } },
    });
    fetchMock.mockResolvedValue({ ok: false, status });

    await expect(
      unsyncEventFromAttendees(supabase as never, "event-1", "gr-event-1"),
    ).resolves.toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "flag_calendar_token_invalid",
      expect.anything(),
    );
  });
});

describe("syncEventToUser / unsyncEventFromUser", () => {
  it("syncEventToUser pushes only the matching target's calendar", async () => {
    const targets = [makeTarget("user-1"), makeTarget("user-2")];
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: targets, error: null } },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await syncEventToUser(supabase as never, "event-1", "user-2", EVENT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-token-user-2" });
  });

  it("syncEventToUser is a no-op when the user isn't in the target list", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [makeTarget("user-1")], error: null } },
    });

    await syncEventToUser(supabase as never, "event-1", "user-2", EVENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unsyncEventFromUser deletes only the matching target's calendar", async () => {
    const targets = [makeTarget("user-1"), makeTarget("user-2")];
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: targets, error: null } },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await unsyncEventFromUser(supabase as never, "event-1", "user-1", "gr-event-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-token-user-1" });
    expect(init.method).toBe("DELETE");
  });

  it("unsyncEventFromUser is a no-op when the user isn't in the target list", async () => {
    const supabase = makeSupabase({
      rpc: { get_event_sync_targets: { data: [], error: null } },
    });

    await unsyncEventFromUser(supabase as never, "event-1", "user-1", "gr-event-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("syncAllEventsForUser", () => {
  it("is a no-op when the user has no connected/valid token", async () => {
    const supabase = makeSupabase({
      rpc: { get_user_sync_targets: { data: [], error: null } },
    });

    await syncAllEventsForUser(supabase as never, "user-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes every event the user is an attendee of onto their own calendar", async () => {
    const target = makeTarget("user-1");
    const supabase = makeSupabase({
      rpc: { get_user_sync_targets: { data: [target], error: null } },
      eventAttendees: { data: [{ event_id: "event-1" }, { event_id: "event-2" }], error: null },
      events: {
        data: [
          {
            id: "event-1",
            google_calendar_event_id: "gr-event-1",
            name: "Rehearsal",
            location: "Main hall",
            notes: null,
            start_time: "2026-07-12T09:00:00.000Z",
            end_time: "2026-07-12T11:00:00.000Z",
          },
          {
            id: "event-2",
            google_calendar_event_id: null, // legacy row — skipped
            name: "Legacy event",
            location: null,
            notes: null,
            start_time: "2026-07-13T09:00:00.000Z",
            end_time: "2026-07-13T11:00:00.000Z",
          },
        ],
        error: null,
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await syncAllEventsForUser(supabase as never, "user-1");

    // Only event-1 (has a google_calendar_event_id) is pushed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/gr-event-1",
    );
  });

  it("is a no-op when the user has no attendee rows", async () => {
    const supabase = makeSupabase({
      rpc: { get_user_sync_targets: { data: [makeTarget("user-1")], error: null } },
      eventAttendees: { data: [], error: null },
    });

    await syncAllEventsForUser(supabase as never, "user-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the event_attendees lookup errors", async () => {
    const supabase = makeSupabase({
      rpc: { get_user_sync_targets: { data: [makeTarget("user-1")], error: null } },
      eventAttendees: { data: null, error: { message: "db error" } },
    });

    await expect(syncAllEventsForUser(supabase as never, "user-1")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
