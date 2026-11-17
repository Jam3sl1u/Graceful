import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    "song2score/**",
    ".claude/**",
    ".pipeline/**",
    "documentation/**",
    ".next/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Scaffolded route/lib stubs intentionally name unused params `_foo`
      // (Sprint 1+ work fills in the real implementation).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
