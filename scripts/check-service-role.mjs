#!/usr/bin/env node
// Repo-wide guard for issue #23 (PRD §19.3, §25.1): fails if the Supabase
// service role key is referenced in user-callable code under app/ or lib/.
// Comments are allowed to mention it (e.g. the warning in
// lib/supabase/client.ts) — only non-comment occurrences fail the check.
//
// Usage: node scripts/check-service-role.mjs   (exit 0 = clean, exit 1 = violation)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["app", "lib"].map((d) => join(REPO_ROOT, d));
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const PATTERNS = [
  { name: "SUPABASE_SERVICE_ROLE_KEY", regex: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: "service_role", regex: /service_role/i },
];

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, files);
    } else if (stats.isFile()) {
      const ext = fullPath.slice(fullPath.lastIndexOf("."));
      if (SCAN_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function scanFile(filePath) {
  const violations = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    for (const pattern of PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        violations.push({
          path: filePath,
          line: index + 1,
          matched: match[0],
        });
      }
    }
  });
  return violations;
}

function main() {
  const files = SCAN_DIRS.flatMap((dir) => walk(dir));

  if (files.length === 0) {
    console.error("ERROR: no files found to scan — check SCAN_DIRS paths.");
    process.exit(1);
  }

  const allViolations = files.flatMap((file) => scanFile(file));

  if (allViolations.length > 0) {
    for (const violation of allViolations) {
      console.error(`${violation.path}:${violation.line} - ${violation.matched}`);
    }
    process.exit(1);
  }

  console.log("OK: no service-role key references found outside comments in app/ or lib/.");
  process.exit(0);
}

main();
