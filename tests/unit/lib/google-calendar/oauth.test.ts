// Tests for lib/google-calendar/oauth.ts (connect URL + code exchange +
// revoke, #61). Mocks global.fetch; sets Google env vars in beforeEach.

import { getAuthUrl, exchangeCode, revokeToken, CALENDAR_EVENTS_SCOPE } from "@/lib/google-calendar/oauth";

const ENV = {
  GOOGLE_CLIENT_ID: "client-id-123",
  GOOGLE_CLIENT_SECRET: "client-secret-456",
  GOOGLE_REDIRECT_URI: "https://app.example.com/api/google-calendar/callback",
};

let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = ENV.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = ENV.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_REDIRECT_URI = ENV.GOOGLE_REDIRECT_URI;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
  jest.restoreAllMocks();
});

describe("getAuthUrl", () => {
  it("builds the consent URL with the calendar.events scope, offline access, consent prompt, and state", () => {
    const url = new URL(getAuthUrl("csrf-state-value"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(ENV.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.GOOGLE_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(CALENDAR_EVENTS_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("csrf-state-value");
  });

  it("throws when GOOGLE_CLIENT_ID is unset", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => getAuthUrl("state")).toThrow();
  });

  it("throws when GOOGLE_REDIRECT_URI is unset", () => {
    delete process.env.GOOGLE_REDIRECT_URI;
    expect(() => getAuthUrl("state")).toThrow();
  });
});

describe("exchangeCode", () => {
  it("returns mapped tokens on a successful exchange", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        access_token: "access-token-value",
        refresh_token: "refresh-token-value",
        expires_in: 3600,
        scope: CALENDAR_EVENTS_SCOPE,
      }),
    });

    const before = Date.now();
    const tokens = await exchangeCode("auth-code");
    const after = Date.now();

    expect(tokens.accessToken).toBe("access-token-value");
    expect(tokens.refreshToken).toBe("refresh-token-value");
    expect(tokens.scope).toBe(CALENDAR_EVENTS_SCOPE);

    const expiry = new Date(tokens.expiryDate).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiry).toBeLessThanOrEqual(after + 3600 * 1000);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when Google returns a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: jest.fn() });

    await expect(exchangeCode("auth-code")).rejects.toThrow();
  });

  it("throws when the response omits refresh_token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        access_token: "access-token-value",
        expires_in: 3600,
        scope: CALENDAR_EVENTS_SCOPE,
      }),
    });

    await expect(exchangeCode("auth-code")).rejects.toThrow();
  });

  it("throws when required Google env vars are unset", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    await expect(exchangeCode("auth-code")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeToken", () => {
  it("never throws when the revoke request succeeds", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(revokeToken("refresh-token-value")).resolves.toBeUndefined();
  });

  it("never throws when the revoke request returns a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    await expect(revokeToken("refresh-token-value")).resolves.toBeUndefined();
  });

  it("never throws when fetch itself rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    await expect(revokeToken("refresh-token-value")).resolves.toBeUndefined();
  });
});
