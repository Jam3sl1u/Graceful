// Tests for lib/resend/client.ts (#68). Mock scaffolding mirrors
// tests/unit/lib/r2/client.test.ts (clearEnv/setValidEnv + isolateModulesAsync
// re-import for the module-scope lazy singleton). Mocks the `resend` SDK —
// no network calls.

const mockSend = jest.fn();
const mockResendCtor = jest.fn().mockImplementation(() => ({ emails: { send: mockSend } }));

jest.mock("resend", () => ({
  Resend: mockResendCtor,
}));

const ENV_KEYS = ["RESEND_API_KEY", "RESEND_FROM_EMAIL"] as const;
const VALID_ENV = {
  RESEND_API_KEY: "re_test_key",
  RESEND_FROM_EMAIL: "Graceful <notifications@graceful.app>",
};

function setValidEnv() {
  for (const key of ENV_KEYS) {
    process.env[key] = VALID_ENV[key];
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

// The module holds a lazy-singleton Resend client at module scope, so every
// test re-imports it fresh to observe construction behavior and env-var
// validation in isolation.
async function importFreshClient() {
  let mod: typeof import("@/lib/resend/client");
  await jest.isolateModulesAsync(async () => {
    mod = await import("@/lib/resend/client");
  });
  return mod!;
}

describe("lib/resend/client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearEnv();
    mockResendCtor.mockClear();
    mockSend.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("sendEmail", () => {
    it("happy path: returns { id } and passes from/to/subject/html/text through to resend.emails.send", async () => {
      setValidEnv();
      mockSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
      const { sendEmail } = await importFreshClient();

      const result = await sendEmail("member@example.com", "invitation_reminder_member", {
        date: "Aug 09, 2026",
        link: "https://graceful.app/invitations/1",
      });

      expect(result).toEqual({ id: "email-123" });
      expect(mockSend).toHaveBeenCalledWith({
        from: VALID_ENV.RESEND_FROM_EMAIL,
        to: "member@example.com",
        subject: "Your invitation for Aug 09, 2026 needs a response",
        html: expect.stringContaining("Your invitation for Aug 09, 2026 needs a response"),
        text: expect.stringContaining("Your invitation for Aug 09, 2026 needs a response"),
      });
    });

    it("throws without calling the SDK when RESEND_API_KEY is missing", async () => {
      setValidEnv();
      delete process.env.RESEND_API_KEY;
      const { sendEmail } = await importFreshClient();

      await expect(
        sendEmail("member@example.com", "invitation_reminder_member", {
          date: "Aug 09, 2026",
          link: "https://graceful.app/invitations/1",
        }),
      ).rejects.toThrow(/Resend is not configured/);
      expect(mockResendCtor).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("throws without calling the SDK when RESEND_FROM_EMAIL is missing", async () => {
      setValidEnv();
      delete process.env.RESEND_FROM_EMAIL;
      const { sendEmail } = await importFreshClient();

      await expect(
        sendEmail("member@example.com", "invitation_reminder_member", {
          date: "Aug 09, 2026",
          link: "https://graceful.app/invitations/1",
        }),
      ).rejects.toThrow(/Resend is not configured/);
      expect(mockResendCtor).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(ENV_KEYS)("throws when %s is present but an empty string", async (emptyKey) => {
      setValidEnv();
      process.env[emptyKey] = "";
      const { sendEmail } = await importFreshClient();

      await expect(
        sendEmail("member@example.com", "invitation_reminder_member", {
          date: "Aug 09, 2026",
          link: "https://graceful.app/invitations/1",
        }),
      ).rejects.toThrow(/Resend is not configured/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("throws when `to` is empty or whitespace-only, before touching env or the SDK", async () => {
      clearEnv();
      const { sendEmail } = await importFreshClient();

      await expect(
        sendEmail("   ", "invitation_reminder_member", {
          date: "Aug 09, 2026",
          link: "https://graceful.app/invitations/1",
        }),
      ).rejects.toThrow("sendEmail requires a recipient address");
      expect(mockResendCtor).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("throws when the SDK returns an { error }", async () => {
      setValidEnv();
      mockSend.mockResolvedValue({ data: null, error: { message: "invalid from address" } });
      const { sendEmail } = await importFreshClient();

      await expect(
        sendEmail("member@example.com", "invitation_reminder_member", {
          date: "Aug 09, 2026",
          link: "https://graceful.app/invitations/1",
        }),
      ).rejects.toThrow("Resend email dispatch failed: invalid from address");
    });

    it("throws a generic message when the SDK returns neither data nor an error message", async () => {
      setValidEnv();
      mockSend.mockResolvedValue({ data: null, error: null });
      const { sendEmail } = await importFreshClient();

      await expect(
        sendEmail("member@example.com", "invitation_reminder_member", {
          date: "Aug 09, 2026",
          link: "https://graceful.app/invitations/1",
        }),
      ).rejects.toThrow("Resend email dispatch failed: unknown error");
    });

    it("constructs the Resend client once across two sends", async () => {
      setValidEnv();
      mockSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
      const { sendEmail } = await importFreshClient();

      await sendEmail("member@example.com", "invitation_reminder_member", {
        date: "Aug 09, 2026",
        link: "https://graceful.app/invitations/1",
      });
      await sendEmail("member2@example.com", "invitation_reminder_member", {
        date: "Aug 09, 2026",
        link: "https://graceful.app/invitations/1",
      });

      expect(mockResendCtor).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("mapResendEventToStatus", () => {
    it.each([
      ["email.sent", "sent"],
      ["email.delivered", "delivered"],
      ["email.delivery_delayed", "delayed"],
      ["email.bounced", "bounced"],
      ["email.complained", "complained"],
      ["email.opened", "opened"],
      ["email.clicked", "clicked"],
    ])("maps %s to %s", async (eventType, expected) => {
      const { mapResendEventToStatus } = await importFreshClient();
      expect(mapResendEventToStatus(eventType)).toBe(expected);
    });

    it("returns null for an unknown event type", async () => {
      const { mapResendEventToStatus } = await importFreshClient();
      expect(mapResendEventToStatus("email.unsubscribed")).toBeNull();
    });
  });
});
