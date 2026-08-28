import { pingramWebhookSchema, toSmsEventType } from "@/schemas/pingram";

describe("pingramWebhookSchema", () => {
  const minimal = { eventType: "SMS_DELIVERED", trackingId: "tracking-1" };

  it("accepts documented fields and strips unknown keys", () => {
    const result = pingramWebhookSchema.safeParse({
      ...minimal,
      channel: "SMS",
      userId: "user-1",
      notificationId: "graceful_notification",
      failureCode: null,
      extra: "ignored",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("extra");
  });

  it("requires non-empty eventType and trackingId", () => {
    expect(pingramWebhookSchema.safeParse({ trackingId: "tracking-1" }).success).toBe(false);
    expect(pingramWebhookSchema.safeParse({ eventType: "SMS_DELIVERED" }).success).toBe(false);
    expect(pingramWebhookSchema.safeParse({ eventType: "", trackingId: "tracking-1" }).success).toBe(false);
  });
});

describe("toSmsEventType", () => {
  it.each(["SMS_DELIVERED", "SMS_FAILED", "SMS_INBOUND", "SMS_SUBSCRIBE", "SMS_UNSUBSCRIBE"])(
    "preserves known SMS event %s",
    (event) => expect(toSmsEventType(event)).toBe(event),
  );

  it("maps unknown and differently cased events to UNKNOWN", () => {
    expect(toSmsEventType("SMS_NEW")).toBe("UNKNOWN");
    expect(toSmsEventType("sms_delivered")).toBe("UNKNOWN");
  });
});
