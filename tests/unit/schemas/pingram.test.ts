// Independent Testing-stage unit tests for schemas/pingram.ts (#67).
// The route test (tests/unit/app/api/webhooks-pingram-route.test.ts) only
// exercises this schema indirectly through the HTTP handler; these tests
// verify pingramWebhookSchema and toDeliveryStatus directly.

import { pingramWebhookSchema, toDeliveryStatus } from "@/schemas/pingram";

describe("pingramWebhookSchema", () => {
  it("accepts a minimal valid payload (happy path)", () => {
    const result = pingramWebhookSchema.safeParse({
      message_id: "msg-1",
      status: "delivered",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full valid payload with all optional fields", () => {
    const result = pingramWebhookSchema.safeParse({
      message_id: "msg-1",
      status: "failed",
      to: "+15551234567",
      error_code: "30003",
      occurred_at: "2026-08-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("strips unknown keys rather than failing (forward-compatible with new provider fields)", () => {
    const result = pingramWebhookSchema.safeParse({
      message_id: "msg-1",
      status: "delivered",
      some_new_field_from_pingram: "unrecognized",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("some_new_field_from_pingram");
    }
  });

  it("allows error_code to be explicitly null (nullish)", () => {
    const result = pingramWebhookSchema.safeParse({
      message_id: "msg-1",
      status: "delivered",
      error_code: null,
    });
    expect(result.success).toBe(true);
  });

  it("fails when message_id is missing (failure case)", () => {
    const result = pingramWebhookSchema.safeParse({ status: "delivered" });
    expect(result.success).toBe(false);
  });

  it("fails when status is missing", () => {
    const result = pingramWebhookSchema.safeParse({ message_id: "msg-1" });
    expect(result.success).toBe(false);
  });

  it("fails when message_id is an empty string", () => {
    const result = pingramWebhookSchema.safeParse({ message_id: "", status: "delivered" });
    expect(result.success).toBe(false);
  });

  it("fails when status is an empty string", () => {
    const result = pingramWebhookSchema.safeParse({ message_id: "msg-1", status: "" });
    expect(result.success).toBe(false);
  });

  it("fails when the payload is not an object", () => {
    expect(pingramWebhookSchema.safeParse(null).success).toBe(false);
    expect(pingramWebhookSchema.safeParse("delivered").success).toBe(false);
    expect(pingramWebhookSchema.safeParse([]).success).toBe(false);
  });
});

describe("toDeliveryStatus", () => {
  it.each(["queued", "sent", "delivered", "failed", "undelivered"])(
    "passes known provider status %s through unchanged",
    (status) => {
      expect(toDeliveryStatus(status)).toBe(status);
    },
  );

  it("maps an unrecognized provider status to 'unknown' (edge case per spec)", () => {
    expect(toDeliveryStatus("some-new-provider-status")).toBe("unknown");
  });

  it("maps an empty string to 'unknown'", () => {
    expect(toDeliveryStatus("")).toBe("unknown");
  });

  it("is case-sensitive: a differently-cased known status maps to 'unknown'", () => {
    expect(toDeliveryStatus("Delivered")).toBe("unknown");
  });
});
