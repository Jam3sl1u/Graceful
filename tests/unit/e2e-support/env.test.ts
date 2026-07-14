/**
 * Tester-added unit coverage for tests/e2e/support/env.ts (issue #52).
 *
 * The four new staging-authenticated E2E specs all gate on this module's
 * `e2eAuthEnabled` / `checkEnv` / `requireEnv`, but none of that gating logic
 * itself runs in CI without staging secrets (the specs just `test.skip`).
 * These are plain env-var-driven functions with no browser/staging
 * dependency, so they're independently verifiable here via Jest — happy
 * path (all required vars present), the two named edge cases (a missing
 * required var, and the `extra` param used by the reminder spec for
 * CRON_SECRET), and a failure case (requireEnv throws on a missing var).
 */

const REQUIRED_VARS = [
  "STAGING_APP_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "E2E_ADMIN_EMAIL",
  "E2E_MEMBER_EMAIL",
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
] as const;

function setAllRequiredVars(): void {
  for (const v of REQUIRED_VARS) {
    process.env[v] = `test-value-${v}`;
  }
}

function clearAllRequiredVars(): void {
  for (const v of REQUIRED_VARS) {
    delete process.env[v];
  }
  delete process.env.CRON_SECRET;
}

describe("tests/e2e/support/env", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe("checkEnv", () => {
    it("happy path: returns true when every required var is set", async () => {
      clearAllRequiredVars();
      setAllRequiredVars();
      const { checkEnv } = await import("../../e2e/support/env");
      expect(checkEnv()).toBe(true);
    });

    it("edge case: returns false when even one required var is missing", async () => {
      clearAllRequiredVars();
      setAllRequiredVars();
      delete process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
      const { checkEnv } = await import("../../e2e/support/env");
      expect(checkEnv()).toBe(false);
    });

    it("edge case: returns false when required vars are set but a spec-specific extra (e.g. CRON_SECRET) is missing", async () => {
      clearAllRequiredVars();
      setAllRequiredVars();
      delete process.env.CRON_SECRET;
      const { checkEnv } = await import("../../e2e/support/env");
      expect(checkEnv(["CRON_SECRET"])).toBe(false);
    });

    it("returns true when required vars plus the extra are all set", async () => {
      clearAllRequiredVars();
      setAllRequiredVars();
      process.env.CRON_SECRET = "test-cron-secret";
      const { checkEnv } = await import("../../e2e/support/env");
      expect(checkEnv(["CRON_SECRET"])).toBe(true);
    });

    it("treats an empty-string var as absent (not just undefined)", async () => {
      clearAllRequiredVars();
      setAllRequiredVars();
      process.env.STAGING_APP_URL = "";
      const { checkEnv } = await import("../../e2e/support/env");
      expect(checkEnv()).toBe(false);
    });
  });

  describe("e2eAuthEnabled", () => {
    it("happy path: is true (computed at import time) when all required vars are present", async () => {
      clearAllRequiredVars();
      setAllRequiredVars();
      const { e2eAuthEnabled } = await import("../../e2e/support/env");
      expect(e2eAuthEnabled).toBe(true);
    });

    it("is false when no secrets are configured (the local/no-staging case every new spec file guards against)", async () => {
      clearAllRequiredVars();
      const { e2eAuthEnabled } = await import("../../e2e/support/env");
      expect(e2eAuthEnabled).toBe(false);
    });
  });

  describe("requireEnv", () => {
    it("happy path: returns the value when the var is set", async () => {
      clearAllRequiredVars();
      process.env.SOME_VAR = "some-value";
      const { requireEnv } = await import("../../e2e/support/env");
      expect(requireEnv("SOME_VAR")).toBe("some-value");
    });

    it("failure case: throws a descriptive error when the var is missing", async () => {
      clearAllRequiredVars();
      delete process.env.SOME_MISSING_VAR;
      const { requireEnv } = await import("../../e2e/support/env");
      expect(() => requireEnv("SOME_MISSING_VAR")).toThrow(
        "Missing required env var for E2E tests: SOME_MISSING_VAR",
      );
    });
  });
});
