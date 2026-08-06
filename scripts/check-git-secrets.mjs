#!/usr/bin/env node
// Repeatable git-history secret scan for issue #78 (PRD §25.7, cited as
// §15.7 in the issue). Scans the *entire* history of the repo — not just the
// working tree — for two things: (1) added lines that look like a known
// secret shape, and (2) committed `.env*` files (other than the checked-in
// `.env.example` placeholder). Wired into CI via
// `.github/workflows/ci.yml`'s `git-secret-scan` job.
//
// Usage: node scripts/check-git-secrets.mjs   (exit 0 = clean, exit 1 = finding or setup error)

import { execFileSync } from "node:child_process";

// Deliberately no `cwd` override here (unlike check-service-role.mjs's
// REPO_ROOT pattern): git itself auto-discovers the repository by walking up
// from the process's actual working directory, so running this script (by
// absolute path or otherwise) against a scratch repo works correctly as long
// as the process is cd'd into that scratch repo first — which is exactly how
// the "exits 1 against a scratch repo with a fake key" test case works.
const EXEC_OPTS = { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 };

// Names from .env.example that hold secrets (as opposed to plain
// configuration like NEXT_PUBLIC_APP_URL or a redirect URI).
const SECRET_ENV_VAR_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SECRET",
  "PINGRAM_API_KEY",
  "PINGRAM_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_WEBHOOK_SECRET",
  "SPOTIFY_CLIENT_SECRET",
  "CRON_SECRET",
  "SUPABASE_JWT_SECRET",
];

const PATTERNS = [
  { name: "Clerk secret key", regex: /\bsk_(test|live)_[A-Za-z0-9]{20,}/ },
  { name: "Resend API key", regex: /\bre_[A-Za-z0-9]{20,}/ },
  { name: "Google OAuth client secret", regex: /\bGOCSPX-[A-Za-z0-9_-]{10,}/ },
  { name: "AWS/R2 access key id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "JWT (Supabase anon/service-role keys are JWTs)",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: "Assigned secret env var",
    regex: new RegExp(
      `\\b(?:${SECRET_ENV_VAR_NAMES.join("|")})\\s*[=:]\\s*["']?[A-Za-z0-9_\\-/+]{12,}["']?`,
    ),
  },
];

// Regexes applied to the *matched text* of a candidate finding. Each entry's
// `reason` documents why it's safe to allowlist — allowlisting on the
// matched value (not the pattern) keeps this narrow: a real secret that
// happens to also contain e.g. "example" as a substring would still need to
// match the *whole* allowlist regex to be suppressed, which none of these do.
const VALUE_ALLOWLIST = [
  { regex: /placeholder/i, reason: "obvious non-secret placeholder text" },
  { regex: /example/i, reason: "obvious non-secret example/documentation value" },
  { regex: /changeme/i, reason: "obvious non-secret placeholder text" },
  { regex: /^your[-_]/i, reason: "obvious non-secret template value (e.g. your-key-here)" },
  { regex: /xxxx/i, reason: "obvious non-secret redacted/template value" },
  {
    regex: /"test-[a-z0-9-]+"/i,
    reason:
      "Jest test-double value for a secret env var (e.g. CRON_SECRET/PINGRAM_API_KEY fixtures " +
      'like "test-cron-secret"), not a real credential',
  },
  {
    regex: /"client-(id|secret)(-\d+)?"/i,
    reason:
      "Jest test-double value for GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fixtures " +
      '(e.g. "client-secret-456"), not a real credential',
  },
];

// Exact paths (or path fragments, for generated test fixtures) skipped
// entirely by the added-line scan. Kept intentionally narrow — .pipeline/**
// and documentation/** deliberately stay in scope, since a pasted real
// secret there is a genuine finding, not a false positive.
const PATH_ALLOWLIST = [
  {
    path: "scripts/check-git-secrets.mjs",
    reason: "this file's own PATTERNS list would otherwise match itself",
  },
];

function isAllowedPath(path) {
  if (PATH_ALLOWLIST.some((entry) => entry.path === path)) return true;
  // Fixtures for this script's own tests will contain fake-secret-looking
  // strings by design.
  if (path.includes("check-git-secrets")) return true;
  return false;
}

function isAllowedValue(matched) {
  return VALUE_ALLOWLIST.some((entry) => entry.regex.test(matched));
}

function redact(matched) {
  const prefix = matched.slice(0, 4);
  return `${prefix}…(len=${matched.length})`;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, EXEC_OPTS);
}

function checkGitRepo() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    fail("not inside a git working tree.");
  }
}

function checkNotShallow() {
  let output;
  try {
    output = git(["rev-parse", "--is-shallow-repository"]).trim();
  } catch {
    fail("failed to determine whether this is a shallow clone.");
    return;
  }
  if (output === "true") {
    fail(
      'this is a shallow clone — a shallow scan can silently report "clean" while ' +
        "missing secrets earlier in history. Re-fetch with full history " +
        "(CI must use `fetch-depth: 0`) and re-run.",
    );
  }
}

function scanAddedLines() {
  const output = git([
    "log",
    "--all",
    "--full-history",
    "--no-color",
    "-p",
    "-U0",
    "--pretty=format:__COMMIT__%H",
  ]);

  const findings = [];
  let currentCommit = null;
  let currentPath = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("__COMMIT__")) {
      currentCommit = line.slice("__COMMIT__".length);
      currentPath = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      currentPath = rest === "/dev/null" ? null : rest.replace(/^b\//, "");
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (!currentPath || isAllowedPath(currentPath)) continue;

    const candidate = line.slice(1);
    for (const pattern of PATTERNS) {
      const match = candidate.match(pattern.regex);
      if (match && !isAllowedValue(match[0])) {
        findings.push({
          commit: currentCommit,
          path: currentPath,
          patternName: pattern.name,
          matched: match[0],
        });
      }
    }
  }

  return findings;
}

function scanCommittedEnvFiles() {
  const output = git([
    "log",
    "--all",
    "--full-history",
    "--diff-filter=A",
    "--name-only",
    "--pretty=format:__COMMIT__%H",
  ]);

  const findings = [];
  let currentCommit = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("__COMMIT__")) {
      currentCommit = line.slice("__COMMIT__".length);
      continue;
    }
    const path = line.trim();
    if (!path) continue;

    const basename = path.slice(path.lastIndexOf("/") + 1);
    const isEnvFile = basename === ".env" || basename.startsWith(".env.");
    if (!isEnvFile || basename === ".env.example") continue;

    findings.push({
      commit: currentCommit,
      path,
      patternName: "Committed .env file",
      matched: path,
    });
  }

  return findings;
}

function main() {
  checkGitRepo();
  checkNotShallow();

  const findings = [...scanAddedLines(), ...scanCommittedEnvFiles()];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${finding.commit} ${finding.path} - ${finding.patternName}: ${redact(finding.matched)}`,
      );
    }
    process.exit(1);
  }

  console.log("OK: no secrets found in git history.");
  process.exit(0);
}

main();
