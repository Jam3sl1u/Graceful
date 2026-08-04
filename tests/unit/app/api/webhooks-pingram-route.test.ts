// Tests for POST /api/webhooks/pingram (#67). Mocks
// @/lib/api/webhook-verify so signature verification behavior is controlled
// per test; NextRequest is faked as a plain object exposing `.text()` and
// `.headers` (see tests/unit/app/api/cron-invitation-reminders-route.test.ts
// makeReq).

jest.mock("@/lib/api/webhook-verify", () => ({ verifyPingramWebhook: jest.fn() }));

import type { NextRequest } from "next/server";
import { verifyPingramWebhook } from "@/lib/api/webhook-verify";
import { POST } from "@/app/api/webhooks/pingram/route";

const mockVerify = verifyPingramWebhook as unknown as jest.Mock;

function makeReq(rawBody: string): NextRequest {
  return {
    text: jest.fn().mockResolvedValue(rawBody),
    headers: { get: jest.fn(() => null) },
  } as unknown as NextRequest;
}

let consoleErrorSpy: jest.SpyInstance;
let consoleInfoSpy: jest.SpyInstance;

beforeEach(() => {
  mockVerify.mockReset();
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleInfoSpy.mockRestore();
});

describe("POST /api/webhooks/pingram", () => {
  it("returns 500 INTERNAL when verifyPingramWebhook throws (missing config)", async () => {
    mockVerify.mockRejectedValue(new Error("PINGRAM_WEBHOOK_SECRET is not set"));

    const res = await POST(makeReq(JSON.stringify({ message_id: "m1", status: "delivered" })));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when the signature is invalid, without ever reaching JSON parsing", async () => {
    mockVerify.mockResolvedValue(false);

    // Deliberately malformed JSON — if the route reached JSON.parse it would
    // 400, not 401. Getting 401 proves the signature gate runs first.
    const res = await POST(makeReq("not valid json{{{"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("returns 400 VALIDATION_FAILED for malformed JSON with a valid signature", async () => {
    mockVerify.mockResolvedValue(true);

    const res = await POST(makeReq("not valid json{{{"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when required fields are missing", async () => {
    mockVerify.mockResolvedValue(true);

    const res = await POST(makeReq(JSON.stringify({ to: "+15551234567" })));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 200 with status 'unknown' for an unrecognized provider status (does not 400)", async () => {
    mockVerify.mockResolvedValue(true);

    const res = await POST(
      makeReq(JSON.stringify({ message_id: "m1", status: "some-new-provider-status" })),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ received: true, messageId: "m1", status: "unknown" });
  });

  it("returns 200 and ignores extra unknown fields in the payload", async () => {
    mockVerify.mockResolvedValue(true);

    const res = await POST(
      makeReq(
        JSON.stringify({
          message_id: "m1",
          status: "delivered",
          to: "+15551234567",
          some_extra_field: "ignored",
        }),
      ),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ received: true, messageId: "m1", status: "delivered" });
  });

  it("happy path: valid signature + valid payload returns 200 with the canonical status", async () => {
    mockVerify.mockResolvedValue(true);

    const res = await POST(
      makeReq(JSON.stringify({ message_id: "m1", status: "failed", error_code: "30003" })),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ received: true, messageId: "m1", status: "failed" });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "pingram webhook: delivery status",
      expect.objectContaining({ messageId: "m1", status: "failed", errorCode: "30003" }),
    );
  });
});
