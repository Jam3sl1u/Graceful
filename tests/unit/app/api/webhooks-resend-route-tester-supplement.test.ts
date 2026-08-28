// Supplementary tests written independently by the Tester stage for #68
// (POST /api/webhooks/resend).
//
// The coder's own webhooks-resend-route.test.ts covers a `data` object
// missing `email_id` (`data: {}`) and a missing `type`, but never exercises
// `data` being absent from the payload entirely, or `data` being present
// but not an object (e.g. a string/array/number) — plausible payload shapes
// a mutation or a real malformed callback could send. It also never checks
// that an empty-string `type` (falsy but still `typeof === "string"`) is
// rejected, which a mutation from `!type` to `type === undefined` would let
// through.

jest.mock("@/lib/api/webhook-verify", () => ({ verifyResendWebhook: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ mapResendEventToStatus: jest.fn() }));

import type { NextRequest } from "next/server";
import { verifyResendWebhook } from "@/lib/api/webhook-verify";
import { mapResendEventToStatus } from "@/lib/resend/client";
import { POST } from "@/app/api/webhooks/resend/route";

const mockVerifyResendWebhook = verifyResendWebhook as unknown as jest.Mock;
const mockMapResendEventToStatus = mapResendEventToStatus as unknown as jest.Mock;

function makeReq(rawBody: string): NextRequest {
  return {
    text: jest.fn().mockResolvedValue(rawBody),
    json: jest.fn().mockRejectedValue(new Error("req.json() must not be called")),
    headers: new Headers({
      "svix-id": "msg_123",
      "svix-timestamp": "1712345678",
      "svix-signature": "v1,signature",
    }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockVerifyResendWebhook.mockReset();
  mockVerifyResendWebhook.mockResolvedValue(true);
  mockMapResendEventToStatus.mockReset();
});

describe("POST /api/webhooks/resend — tester supplement", () => {
  it("400s when the `data` key is entirely absent from the payload", async () => {
    const req = makeReq(JSON.stringify({ type: "email.delivered" }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("400s when `data` is not an object (e.g. a string)", async () => {
    const req = makeReq(JSON.stringify({ type: "email.delivered", data: "email-1" }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("400s when `data` is an array", async () => {
    const req = makeReq(JSON.stringify({ type: "email.delivered", data: ["email-1"] }));

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400s when `type` is an empty string (falsy, but still typeof string)", async () => {
    const req = makeReq(JSON.stringify({ type: "", data: { email_id: "email-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("400s when the whole payload is a JSON array, not an object", async () => {
    const req = makeReq(JSON.stringify(["email.delivered"]));

    const res = await POST(req);
    // Arrays pass `typeof === "object" && !== null` in JS, so this only
    // stays a 400 because the subsequent `type`/`data` field checks fail —
    // guards against a regression that special-cased array payloads.
    expect(res.status).toBe(400);
  });

  it("never includes a recipient/email address field in the success response body", async () => {
    mockMapResendEventToStatus.mockReturnValue("delivered");
    const req = makeReq(
      JSON.stringify({ type: "email.delivered", data: { email_id: "email-1", to: "member@example.com" } }),
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.data).sort()).toEqual(["emailId", "received", "status"]);
    expect(JSON.stringify(body)).not.toContain("member@example.com");
  });
});
