/**
 * Jest config for RLS integration tests.
 *
 * Kept separate from jest.config.js so `bun run test` (CI unit tests) never
 * accidentally picks up integration tests that require a live Supabase instance.
 *
 * Plain CommonJS (not .ts) for the same reason as jest.config.js: Jest
 * auto-bootstraps `ts-node` to load a `.ts` config file, and `ts-node`'s
 * bundled `@cspotcode/source-map-support` crashes at startup on Bun for
 * macOS. See jest.config.js for the full explanation.
 *
 * Run with: bun run test:rls
 * Requires env vars: SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY,
 *                    SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 */
/** @type {import("jest").Config} */
const config = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests/integration"],
  testMatch: ["**/tests/integration/rls/**/*.test.ts"],
  transform: {
    "^.+\\.(t|j)sx?$": "@swc/jest",
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  testTimeout: 30_000,
  // Integration tests are sequential to avoid seed/cleanup races
  maxWorkers: 1,
};

module.exports = config;
