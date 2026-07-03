import type { Config } from "jest";

/**
 * Jest config for RLS integration tests.
 *
 * Kept separate from jest.config.ts so `bun run test` (CI unit tests) never
 * accidentally picks up integration tests that require a live Supabase instance.
 *
 * Run with: bun run test:rls
 * Requires env vars: SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY,
 *                    SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 */
const config: Config = {
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

export default config;
