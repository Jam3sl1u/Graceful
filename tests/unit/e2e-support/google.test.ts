/**
 * Tester-added unit coverage for tests/e2e/support/google.ts (issue #66).
 *
 * tests/e2e/support/google.ts deliberately hand-duplicates two small pure
 * functions from lib/google-calendar/ (it cannot import lib/ directly — see
 * the header comment in that file: those modules `import "server-only"`,
 * which throws under the plain-Node Playwright runner). Jest, unlike
 * Playwright, maps "server-only" to a mock (jest.config.js
 * moduleNameMapper), so this suite can import both the real lib/ versions
 * and the e2e duplicates side by side and assert they agree — catching any
 * future drift between them. Also covers googleSyncEnabled/e2eCalendarId gating
 * (mirrors tests/unit/e2e-support/env.test.ts's style for e2eAuthEnabled) and
 * a failure case for the key-validation edge case named in the spec.
 */

import { randomBytes } from "crypto";
import { toGoogleEventId as libToGoogleEventId } from "@/lib/google-calendar/sync";
import { decryptToken } from "@/lib/google-calendar/token-crypto";

describe("tests/e2e/support/google", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe("toGoogleEventId", () => {
    it("happy path: agrees with lib/google-calendar/sync.ts's toGoogleEventId", async () => {
      const { toGoogleEventId } = await import("../../e2e/support/google");
      const uuid = "b6a1c2d3-e4f5-4678-9abc-def012345678";
      expect(toGoogleEventId(uuid)).toBe(libToGoogleEventId(uuid));
      expect(toGoogleEventId(uuid)).toBe("gr" + uuid.replace(/-/g, "").toLowerCase());
    });

    it("edge case: agrees with lib/ for a uuid containing uppercase hex digits", async () => {
      const { toGoogleEventId } = await import("../../e2e/support/google");
      const uuid = "B6A1C2D3-E4F5-4678-9ABC-DEF012345678";
      expect(toGoogleEventId(uuid)).toBe(libToGoogleEventId(uuid));
    });
  });

  describe("encryptE2EToken", () => {
    const VALID_KEY = randomBytes(32).toString("base64");

    it("happy path: round-trips through lib/google-calendar/token-crypto.ts's decryptToken", async () => {
      process.env.E2E_TOKEN_ENCRYPTION_KEY = VALID_KEY;
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encryptE2EToken } = await import("../../e2e/support/google");

      const plaintext = "1//0g_example_refresh_token";
      const ciphertext = encryptE2EToken(plaintext);
      expect(decryptToken(ciphertext)).toBe(plaintext);
    });

    it("edge case: produces a distinct ciphertext (distinct IV) for two encryptions of the same input", async () => {
      process.env.E2E_TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encryptE2EToken } = await import("../../e2e/support/google");

      const a = encryptE2EToken("same-plaintext");
      const b = encryptE2EToken("same-plaintext");
      expect(a).not.toBe(b);
    });

    it("failure case: throws when E2E_TOKEN_ENCRYPTION_KEY does not decode to 32 bytes", async () => {
      process.env.E2E_TOKEN_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
      const { encryptE2EToken } = await import("../../e2e/support/google");

      expect(() => encryptE2EToken("x")).toThrow(
        "E2E_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes",
      );
    });

    it("failure case: throws a descriptive error when E2E_TOKEN_ENCRYPTION_KEY is unset", async () => {
      delete process.env.E2E_TOKEN_ENCRYPTION_KEY;
      const { encryptE2EToken } = await import("../../e2e/support/google");

      expect(() => encryptE2EToken("x")).toThrow(
        "Missing required env var for E2E tests: E2E_TOKEN_ENCRYPTION_KEY",
      );
    });
  });

  describe("googleSyncEnabled", () => {
    // checkEnv(extra) (tests/e2e/support/env.ts) always checks the base
    // REQUIRED_VARS plus whatever `extra` array is passed in — so
    // googleSyncEnabled (checkEnv(GOOGLE_SYNC_VARS)) requires BOTH the base
    // E2E secrets AND the four Google-specific ones. Only REQUIRED_VARS
    // itself (env.ts) was deliberately left unmodified, so the base
    // e2eAuthEnabled suite doesn't gain a new hard dependency.
    const REQUIRED_VARS = [
      "STAGING_APP_URL",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "E2E_ADMIN_EMAIL",
      "E2E_MEMBER_EMAIL",
      "E2E_SUPABASE_URL",
      "E2E_SUPABASE_SERVICE_ROLE_KEY",
    ] as const;
    const GOOGLE_VARS = [
      "E2E_TOKEN_ENCRYPTION_KEY",
      "E2E_GOOGLE_CLIENT_ID",
      "E2E_GOOGLE_CLIENT_SECRET",
      "E2E_GOOGLE_REFRESH_TOKEN",
    ] as const;

    function setAll(): void {
      for (const v of [...REQUIRED_VARS, ...GOOGLE_VARS]) process.env[v] = `test-value-${v}`;
    }

    function clearAll(): void {
      for (const v of [...REQUIRED_VARS, ...GOOGLE_VARS]) delete process.env[v];
    }

    it("happy path: is true (computed at import time) when the base E2E vars and all four Google sync vars are present", async () => {
      clearAll();
      setAll();
      const { googleSyncEnabled } = await import("../../e2e/support/google");
      expect(googleSyncEnabled).toBe(true);
    });

    it("edge case: is false when even one of the four Google sync vars is missing", async () => {
      clearAll();
      setAll();
      delete process.env.E2E_GOOGLE_REFRESH_TOKEN;
      const { googleSyncEnabled } = await import("../../e2e/support/google");
      expect(googleSyncEnabled).toBe(false);
    });

    it("edge case: is false when the Google sync vars are set but a base E2E var (e.g. STAGING_APP_URL) is missing", async () => {
      clearAll();
      setAll();
      delete process.env.STAGING_APP_URL;
      const { googleSyncEnabled } = await import("../../e2e/support/google");
      expect(googleSyncEnabled).toBe(false);
    });
  });

  describe("e2eCalendarId", () => {
    it("happy path: returns E2E_GOOGLE_CALENDAR_ID when set", async () => {
      process.env.E2E_GOOGLE_CALENDAR_ID = "some-calendar-id@group.calendar.google.com";
      const { e2eCalendarId } = await import("../../e2e/support/google");
      expect(e2eCalendarId()).toBe("some-calendar-id@group.calendar.google.com");
    });

    it("edge case: defaults to \"primary\" when E2E_GOOGLE_CALENDAR_ID is unset", async () => {
      delete process.env.E2E_GOOGLE_CALENDAR_ID;
      const { e2eCalendarId } = await import("../../e2e/support/google");
      expect(e2eCalendarId()).toBe("primary");
    });
  });
});
