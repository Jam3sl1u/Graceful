// Tests for lib/pingram/client.ts (#67 Pingram SMS dispatch). Mocks
// global.fetch (Pingram send endpoint), same pattern as
// tests/unit/lib/google-calendar/sync.test.ts. Every skip/validation/config
// failure path must never call fetch.

import {
  sendSms,
  toE164,
  SmsNotConfiguredError,
  SmsValidationError,
  SmsDispatchError,
} from "@/lib/pingram/client";

let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.PINGRAM_API_KEY = "test-api-key";
  delete process.env.PINGRAM_API_BASE_URL;
  delete process.env.PINGRAM_SENDER;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete process.env.PINGRAM_API_KEY;
  delete process.env.PINGRAM_API_BASE_URL;
  delete process.env.PINGRAM_SENDER;
});

describe("toE164", () => {
  it("passes through an already-E.164 number unchanged", () => {
    expect(toE164("+15551234567")).toBe("+15551234567");
  });

  it("normalizes a bare 10-digit number to +1", () => {
    expect(toE164("5551234567")).toBe("+15551234567");
  });

  it("normalizes an 11-digit number starting with 1", () => {
    expect(toE164("15551234567")).toBe("+15551234567");
  });

  it("strips spaces, dashes, dots, and parens before normalizing", () => {
    expect(toE164("(555) 123-4567")).toBe("+15551234567");
    expect(toE164("555-123-4567")).toBe("+15551234567");
    expect(toE164("555.123.4567")).toBe("+15551234567");
  });

  it("returns null for letters", () => {
    expect(toE164("555-CALL-NOW")).toBeNull();
  });

  it("returns null for a 7-digit number", () => {
    expect(toE164("5551234")).toBeNull();
  });

  it("returns null for a 12-digit number", () => {
    expect(toE164("155512345678")).toBeNull();
  });

  it("rejects non-US E.164 numbers", () => {
    expect(toE164("+442071838750")).toBeNull();
  });

  it("returns null for empty/null/undefined", () => {
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
  });
});

describe("sendSms", () => {
  it("skips with not_opted_in when smsOptedIn is false, no network call", async () => {
    const result = await sendSms({ to: "+15551234567", body: "hi", smsOptedIn: false });
    expect(result).toEqual({ status: "skipped", reason: "not_opted_in" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("not_opted_in wins even when phone is also missing (consent checked first)", async () => {
    const result = await sendSms({ to: null, body: "hi", smsOptedIn: false });
    expect(result).toEqual({ status: "skipped", reason: "not_opted_in" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips with no_phone when to is null", async () => {
    const result = await sendSms({ to: null, body: "hi", smsOptedIn: true });
    expect(result).toEqual({ status: "skipped", reason: "no_phone" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips with no_phone when to is empty/whitespace", async () => {
    expect(await sendSms({ to: "", body: "hi", smsOptedIn: true })).toEqual({
      status: "skipped",
      reason: "no_phone",
    });
    expect(await sendSms({ to: "   ", body: "hi", smsOptedIn: true })).toEqual({
      status: "skipped",
      reason: "no_phone",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips with invalid_phone when to cannot be normalized", async () => {
    const result = await sendSms({ to: "555-CALL-NOW", body: "hi", smsOptedIn: true });
    expect(result).toEqual({ status: "skipped", reason: "invalid_phone" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws SmsValidationError for empty/whitespace-only body, no network call", async () => {
    await expect(
      sendSms({ to: "+15551234567", body: "", smsOptedIn: true }),
    ).rejects.toBeInstanceOf(SmsValidationError);
    await expect(
      sendSms({ to: "+15551234567", body: "   ", smsOptedIn: true }),
    ).rejects.toBeInstanceOf(SmsValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a body of exactly 160 chars", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ trackingId: "m1" }) });
    const body = "a".repeat(160);
    const result = await sendSms({ to: "+15551234567", body, smsOptedIn: true });
    expect(result).toEqual({ status: "sent", messageId: "m1" });
  });

  it("throws SmsValidationError for a body of 161 chars, no network call", async () => {
    const body = "a".repeat(161);
    await expect(sendSms({ to: "+15551234567", body, smsOptedIn: true })).rejects.toBeInstanceOf(
      SmsValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws SmsNotConfiguredError when PINGRAM_API_KEY is unset, no network call", async () => {
    delete process.env.PINGRAM_API_KEY;
    await expect(
      sendSms({ to: "+15551234567", body: "hi", smsOptedIn: true }),
    ).rejects.toBeInstanceOf(SmsNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws SmsNotConfiguredError when PINGRAM_API_KEY is an empty string, no network call", async () => {
    process.env.PINGRAM_API_KEY = "";
    await expect(
      sendSms({ to: "+15551234567", body: "hi", smsOptedIn: true }),
    ).rejects.toBeInstanceOf(SmsNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a POST to the documented endpoint with Bearer auth and {type, to, message}", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ trackingId: "m1" }) });

    await sendSms({ to: "(555) 123-4567", body: "hello", smsOptedIn: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pingram.io/sms");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      type: "graceful_notification",
      to: "+15551234567",
      message: "hello",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honors PINGRAM_API_BASE_URL override", async () => {
    process.env.PINGRAM_API_BASE_URL = "https://pingram.example.test";
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ trackingId: "m1" }) });

    await sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://pingram.example.test/sms");
  });

  it("includes 'from' only when PINGRAM_SENDER is set and non-empty", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ trackingId: "m1" }) });
    await sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true });
    let [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("from");

    process.env.PINGRAM_SENDER = "+15559990000";
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ trackingId: "m2" }) });
    await sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true });
    [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ from: "+15559990000" });
  });

  it("throws SmsDispatchError with status on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    await expect(
      sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true }),
    ).rejects.toBeInstanceOf(SmsDispatchError);
  });

  it("throws SmsDispatchError with status on a 5xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });

    await expect(
      sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws SmsDispatchError on a network error / timeout", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(
      sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true }),
    ).rejects.toBeInstanceOf(SmsDispatchError);
  });

  it("returns messageId: null for a 2xx response with a non-JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true });
    expect(result).toEqual({ status: "sent", messageId: null });
  });

  it("returns messageId: null for a 2xx response with no id field", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true });
    expect(result).toEqual({ status: "sent", messageId: null });
  });

  it("returns messageId from trackingId", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ trackingId: "tracking-id" }),
    });

    const result = await sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true });
    expect(result).toEqual({ status: "sent", messageId: "tracking-id" });
  });

  it("throws SmsDispatchError when a 200 response contains a structured error", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ trackingId: "tracking-id", error: { message: "Sender unavailable" } }),
    });

    await expect(
      sendSms({ to: "+15551234567", body: "hello", smsOptedIn: true }),
    ).rejects.toMatchObject({ name: "SmsDispatchError", message: "Sender unavailable", status: 200 });
  });
});
