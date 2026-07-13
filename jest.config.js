// Plain CommonJS (not .ts) is deliberate: Jest auto-bootstraps `ts-node` to
// load a `.ts` config file, and `ts-node`'s bundled `@cspotcode/source-map-support`
// crashes at startup on Bun for macOS ("TypeError: Attempted to assign to
// readonly property") when it tries to monkey-patch Error.prepareStackTrace.
// The config object itself is unaffected either way — only the loader differs.
/** @type {import("jest").Config} */
const config = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests", "<rootDir>/lib", "<rootDir>/app"],
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/song2score/",
    "<rootDir>/.pipeline/",
    "<rootDir>/tests/e2e/",
    "<rootDir>/tests/integration/",
  ],
  testMatch: ["**/tests/unit/**/*.test.ts"],
  transform: {
    "^.+\\.(t|j)sx?$": "@swc/jest",
  },
  moduleNameMapper: {
    "^server-only$": "<rootDir>/tests/mocks/server-only.js",
    "^@/(.*)$": "<rootDir>/$1",
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  collectCoverageFrom: [
    "app/api/church-group/**/*.ts",
    "app/api/profile/**/*.ts",
    "app/api/instruments/**/*.ts",
    "lib/api/**/*.ts",
  ],
  coveragePathIgnorePatterns: ["<rootDir>/node_modules/"],
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["text-summary", "lcov"],
};

module.exports = config;
