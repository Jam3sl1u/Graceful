// Supplementary tests written independently by the Tester stage for #68
// (lib/resend/client.ts).
//
// The coder's own client.test.ts confirms the Resend constructor is called
// once across two sends, but always leaves valid env vars in place for both
// calls. That alone doesn't distinguish "constructed once and cached" from
// "re-validates env every call but happens to still pass." This file clears
// the env vars *between* two sends on the same module instance to confirm
// the client is genuinely cached and env is only read on first use — a
// real lazy-singleton contract per lib/r2/client.ts's pattern that the spec
// says to follow exactly.

// The coder's client.test.ts has no top-level import/export, so TS treats
// it as a global script; `export {}` scopes this file as its own module so
// its identically-named mock locals below don't collide with that file.
export {};

const mockSend = jest.fn();
const mockResendCtor = jest.fn().mockImplementation(() => ({ emails: { send: mockSend } }));

jest.mock("resend", () => ({
  Resend: mockResendCtor,
}));

const ENV_KEYS = ["RESEND_API_KEY", "RESEND_FROM_EMAIL"] as const;

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

async function importFreshClient() {
  let mod: typeof import("@/lib/resend/client");
  await jest.isolateModulesAsync(async () => {
    mod = await import("@/lib/resend/client");
  });
  return mod!;
}

describe("lib/resend/client — tester supplement", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearEnv();
    mockResendCtor.mockClear();
    mockSend.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not re-validate env vars on a second sendEmail once the client is already constructed", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "Graceful <notifications@graceful.app>";
    mockSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
    const { sendEmail } = await importFreshClient();

    await sendEmail("member@example.com", "invitation_reminder_member", {
      date: "Aug 09, 2026",
      link: "https://graceful.app/invitations/1",
    });

    // Now clear env entirely — a re-validating implementation would throw
    // on the second call; a genuinely-cached singleton must not.
    clearEnv();

    await expect(
      sendEmail("member2@example.com", "invitation_reminder_member", {
        date: "Aug 09, 2026",
        link: "https://graceful.app/invitations/1",
      }),
    ).resolves.toEqual({ id: "email-123" });

    expect(mockResendCtor).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("a from address without a display name (plain email) is also passed through verbatim", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "notifications@graceful.app";
    mockSend.mockResolvedValue({ data: { id: "email-456" }, error: null });
    const { sendEmail } = await importFreshClient();

    await sendEmail("member@example.com", "invitation_reminder_member", {
      date: "Aug 09, 2026",
      link: "https://graceful.app/invitations/1",
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: "notifications@graceful.app" }),
    );
  });
});
