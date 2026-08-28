jest.mock("@/lib/api/webhook-verify", () => ({ verifyPingramWebhook: jest.fn() }));

import type { NextRequest } from "next/server";
import { verifyPingramWebhook } from "@/lib/api/webhook-verify";
import { POST } from "@/app/api/webhooks/pingram/route";

const mockVerify = verifyPingramWebhook as unknown as jest.Mock;

function makeReq(rawBody: string): NextRequest {
  return { text: jest.fn().mockResolvedValue(rawBody), headers: { get: jest.fn(() => null) } } as unknown as NextRequest;
}

let consoleInfoSpy: jest.SpyInstance;
beforeEach(() => {
  mockVerify.mockReset();
  consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => consoleInfoSpy.mockRestore());

describe("POST /api/webhooks/pingram", () => {
  it("returns 401 before parsing an invalidly signed request", async () => {
    mockVerify.mockResolvedValue(false);
    const res = await POST(makeReq("not-json"));
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed JSON or an invalid payload after verification", async () => {
    mockVerify.mockResolvedValue(true);
    expect((await POST(makeReq("not-json"))).status).toBe(400);
    expect((await POST(makeReq(JSON.stringify({ eventType: "SMS_DELIVERED" })))).status).toBe(400);
  });

  it("acknowledges a failed delivery event", async () => {
    mockVerify.mockResolvedValue(true);
    const res = await POST(makeReq(JSON.stringify({ eventType: "SMS_FAILED", trackingId: "track-1", failureCode: "CARRIER" })));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { received: true, trackingId: "track-1", event: "SMS_FAILED" } });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "pingram webhook: sms event",
      expect.objectContaining({ trackingId: "track-1", event: "SMS_FAILED", failureCode: "CARRIER" }),
    );
  });

  it("acknowledges inbound and unknown events so Pingram will not retry", async () => {
    mockVerify.mockResolvedValue(true);
    const inbound = await POST(makeReq(JSON.stringify({ eventType: "SMS_INBOUND", trackingId: "track-2" })));
    await expect(inbound.json()).resolves.toEqual({ data: { received: true, trackingId: "track-2", event: "SMS_INBOUND" } });
    const unknown = await POST(makeReq(JSON.stringify({ eventType: "SMS_FUTURE", trackingId: "track-3" })));
    await expect(unknown.json()).resolves.toEqual({ data: { received: true, trackingId: "track-3", event: "UNKNOWN" } });
  });
});
