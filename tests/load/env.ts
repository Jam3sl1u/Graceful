/**
 * Env-var gating for the Bun + TypeScript load-test harness (issue #81,
 * PRD §14.1 Performance Requirements). Mirrors the doc-comment /
 * REQUIRED_VARS / requireEnv shape of tests/e2e/support/env.ts, but this
 * harness runs as a bare `bun run` CLI (tests/load/run.ts) rather than under
 * Jest/Playwright, so `readEnv` returns a three-way EnvState instead of a
 * boolean flag — "partial" env (some but not all required vars set) is a
 * distinct, reportable failure mode with its own exit code (see
 * documentation/performance-testing.md §5).
 *
 * Required env vars (documentation/performance-testing.md §4 explains how to
 * obtain them):
 *   LOAD_TEST_BASE_URL      — staging base URL (falls back to STAGING_APP_URL)
 *   LOAD_TEST_ADMIN_TOKENS  — comma-separated Clerk session JWTs (admin persona)
 *   LOAD_TEST_MEMBER_TOKENS — comma-separated Clerk session JWTs (member persona)
 *
 * Optional:
 *   LOAD_TEST_SONG_ID — song uuid with >=1 attached document; the signed-URL
 *                        scenario reports `skipped` when this is absent.
 *
 * Never log, print, or write a token value (including in error messages or
 * the markdown report) — `check:git-secrets` runs in CI and a leaked JWT in
 * a committed artifact is a security incident.
 */

export type LoadTestConfig = {
  baseUrl: string; // trailing slash stripped
  adminTokens: string[]; // >= 1
  memberTokens: string[]; // >= 1
  songId: string | null; // LOAD_TEST_SONG_ID, null when unset
};

/** "unconfigured" = none of the vars set; "partial" = some but not all. */
export type EnvState =
  | { kind: "configured"; config: LoadTestConfig }
  | { kind: "unconfigured" }
  | { kind: "partial"; missing: string[] };

const REQUIRED_VARS = [
  "LOAD_TEST_BASE_URL",
  "LOAD_TEST_ADMIN_TOKENS",
  "LOAD_TEST_MEMBER_TOKENS",
] as const;

function splitTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvState {
  const baseUrlRaw = env.LOAD_TEST_BASE_URL || env.STAGING_APP_URL || "";
  const adminTokens = splitTokens(env.LOAD_TEST_ADMIN_TOKENS);
  const memberTokens = splitTokens(env.LOAD_TEST_MEMBER_TOKENS);
  const songIdRaw = env.LOAD_TEST_SONG_ID?.trim() ?? "";

  // Deliberately excludes the STAGING_APP_URL fallback: that var is set for
  // general (non-load-test) purposes in most environments, so its mere
  // presence must not turn "nobody configured the load harness" into
  // "partially configured" (exit 2) — only an explicit LOAD_TEST_* var
  // counts as an attempt to configure this harness (see §5's exit-code
  // table: unconfigured ⇒ exit 0 skip).
  const explicitlySet =
    Boolean(env.LOAD_TEST_BASE_URL) ||
    adminTokens.length > 0 ||
    memberTokens.length > 0 ||
    Boolean(songIdRaw);
  if (!explicitlySet) {
    return { kind: "unconfigured" };
  }

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push("LOAD_TEST_BASE_URL");
  if (adminTokens.length === 0) missing.push("LOAD_TEST_ADMIN_TOKENS");
  if (memberTokens.length === 0) missing.push("LOAD_TEST_MEMBER_TOKENS");

  if (missing.length > 0) {
    return { kind: "partial", missing };
  }

  return {
    kind: "configured",
    config: {
      baseUrl: baseUrlRaw.replace(/\/+$/, ""),
      adminTokens,
      memberTokens,
      songId: songIdRaw.length > 0 ? songIdRaw : null,
    },
  };
}

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var for load tests: ${name}`);
  return val;
}

// Re-exported for symmetry with tests/e2e/support/env.ts's REQUIRED_VARS —
// not otherwise consumed within tests/load/**.
export { REQUIRED_VARS };
