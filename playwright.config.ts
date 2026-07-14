import { defineConfig } from "@playwright/test";

// Local runs (and CI without staging secrets) spin up a local `bun run dev`
// server. Staging E2E runs (issue #52, OQ4) instead target the real
// deployed staging app via STAGING_APP_URL — the same GitHub Actions secret
// name the invitation-reminders cron workflow already uses
// (documentation/staging-environment.md §6) — and skip webServer entirely,
// since there is no local server to spawn.
const stagingURL = process.env.STAGING_APP_URL;
const baseURL = stagingURL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  // The staging-authenticated suite (invitation-accept/deny/reminder,
  // conflict-detection — issue #52) shares one stable seeded admin/member
  // fixture across the whole run (tests/e2e/support/fixtures.ts) and must
  // run one test at a time to avoid seed/cleanup races — mirrors the RLS
  // integration suite's `maxWorkers: 1` (jest.config.integration.js) for the
  // same reason.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: "./tests/e2e/support/global-setup.ts",
  use: {
    baseURL,
  },
  webServer: stagingURL
    ? undefined
    : {
        command: "bun run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
      },
});
