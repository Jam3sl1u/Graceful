// Tester supplement for #62 (Google Calendar event sync — lib/google-calendar/sync.ts).
//
// Independently covers spec edge case #10 ("Missing TOKEN_ENCRYPTION_KEY /
// Google env vars — existing helpers throw; the per-attendee try/catch
// swallows it (logged), request still succeeds. Never log token plaintext or
// the key.") via a corrupted access_token_encrypted value, which the
// coder's own sync.test.ts does not exercise (it only exercises
// GoogleTokenInvalidError and 5xx/network-shaped failures, not a decrypt
// failure). Also independently re-verifies per-attendee isolation with a
// mixed real failure (decrypt error) + success across two targets, and
// asserts the console.error call for the failing attendee never contains the
// plaintext access/refresh token strings.

jest.mock("@/lib/google-calendar/oauth", () => {
  const actual = jest.requireActual("@/lib/google-calendar/oauth");
  return {
    ...actual,
    refreshAccessToken: jest.fn(),
  };
});

import { encryptToken } from "@/lib/google-calendar/token-crypto";
import { refreshAccessToken } from "@/lib/google-calendar/oauth";
import { syncEventToAttendees, type CalendarEventInput } from "@/lib/google-calendar/sync";

const mockRefreshAccessToken = refreshAccessToken as unknown as jest.Mock;

const KEY = Buffer.alloc(32, 7).toString("base64");

type RpcResult = { data?: unknown; error?: unknown };

function makeSupabase(rpc: Record<string, RpcResult>) {
  return {
    rpc: jest.fn((fn: string) => Promise.resolve(rpc[fn] ?? { data: null, error: null })),
    from: jest.fn(() => {
      throw new Error("unexpected .from() call");
    }),
  };
}

const EVENT: CalendarEventInput = {
  googleEventId: "gr-event-supplement",
  name: "Supplement rehearsal",
  location: null,
  notes: null,
  startTime: "2026-07-12T09:00:00.000Z",
  endTime: "2026-07-12T11:00:00.000Z",
};

const PLAINTEXT_ACCESS_TOKEN = "super-secret-access-token-value";
const PLAINTEXT_REFRESH_TOKEN = "super-secret-refresh-token-value";

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

describe("tester supplement: syncEventToAttendees — decrypt-failure graceful degradation (spec edge case #10)", () => {
  it("swallows a corrupted access_token_encrypted value (decryptToken throws), never flags the token invalid, and never logs the plaintext token", async () => {
    const corruptedTarget = {
      user_id: "user-corrupted",
      access_token_encrypted: "not-a-valid-ciphertext-at-all",
      refresh_token_encrypted: encryptToken(PLAINTEXT_REFRESH_TOKEN),
      token_expiry: new Date(Date.now() + 3_600_000).toISOString(), // not expired -> uses access token path directly
      calendar_id: "primary",
    };
    const supabase = makeSupabase({
      get_event_sync_targets: { data: [corruptedTarget], error: null },
    });

    await expect(
      syncEventToAttendees(supabase as never, "event-1", EVENT),
    ).resolves.toBeUndefined();

    // Decrypt failed before any network call could be made.
    expect(fetchMock).not.toHaveBeenCalled();
    // A corrupt ciphertext is a plain decrypt error, not invalid_grant — must
    // NOT flag the token invalid (that would incorrectly notify the member to
    // reconnect when the real problem is a corrupted DB value).
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "flag_calendar_token_invalid",
      expect.anything(),
    );

    // Never log the plaintext token or the encryption key anywhere in the
    // logged error call.
    const loggedArgs = consoleErrorSpy.mock.calls.flat().map((a) => String(a));
    const loggedText = loggedArgs.join(" ");
    expect(loggedText).not.toContain(PLAINTEXT_ACCESS_TOKEN);
    expect(loggedText).not.toContain(PLAINTEXT_REFRESH_TOKEN);
    expect(loggedText).not.toContain(KEY);
  });

  it("isolates a decrypt failure on one attendee from a genuinely successful sync on another", async () => {
    const corruptedTarget = {
      user_id: "user-corrupted",
      access_token_encrypted: "garbage",
      refresh_token_encrypted: encryptToken(PLAINTEXT_REFRESH_TOKEN),
      token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
      calendar_id: "primary",
    };
    const healthyTarget = {
      user_id: "user-healthy",
      access_token_encrypted: encryptToken(PLAINTEXT_ACCESS_TOKEN),
      refresh_token_encrypted: encryptToken(PLAINTEXT_REFRESH_TOKEN),
      token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
      calendar_id: "primary",
    };
    const supabase = makeSupabase({
      get_event_sync_targets: { data: [corruptedTarget, healthyTarget], error: null },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await syncEventToAttendees(supabase as never, "event-1", EVENT);

    // Only the healthy attendee actually reaches Google.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${PLAINTEXT_ACCESS_TOKEN}` });
  });
});
