#!/usr/bin/env node
// Guard for the #41/#42 pipeline incident (2026-07): a `.claude/workflows/*.js`
// script whose agent() calls silently execute against the wrong working
// directory can look completely fine on read-through — only a live run
// exposes it. This is the automated backstop: syntax-check every workflow
// script, and flag any `agent(` call site that isn't wrapped in a `pin(...)`
// helper (or explicitly exempted with a `// no-pin: <reason>` comment on the
// previous line), since an un-pinned call is exactly how that bug happened.
//
// Usage: node scripts/check-workflows.mjs   (exit 0 = clean, exit 1 = violation)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".claude", "workflows");

function listWorkflowScripts(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((entry) => join(dir, entry))
    .filter((fullPath) => statSync(fullPath).isFile() && fullPath.endsWith(".js"));
}

function checkSyntax(filePath) {
  try {
    execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
    return null;
  } catch (error) {
    return error.stderr?.toString().trim() || error.message;
  }
}

// Matches an `agent(` call site. Doesn't need to be a full JS parser -- this
// is a heuristic guard, not a compiler -- so it just looks at how the call's
// first argument begins.
const AGENT_CALL = /\bagent\(\s*/g;

function findUnpinnedAgentCalls(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const violations = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    if (!AGENT_CALL.test(line)) {
      AGENT_CALL.lastIndex = 0;
      return;
    }
    AGENT_CALL.lastIndex = 0;

    const prevLine = index > 0 ? lines[index - 1].trim() : "";
    const isExempt = /^\/\/\s*no-pin:/.test(prevLine);
    if (isExempt) return;

    // The call's first argument, starting right after `agent(`, must begin
    // with `pin(` (allowing for the multi-line `await agent(\n  pin(...` style
    // used throughout handle-issues.js) or the line itself must already
    // contain `pin(` immediately after `agent(`.
    const afterCall = line.slice(line.indexOf("agent(") + "agent(".length).trim();
    const nextLine = index + 1 < lines.length ? lines[index + 1].trim() : "";
    const startsWithPin = afterCall.startsWith("pin(") || nextLine.startsWith("pin(");

    if (!startsWithPin) {
      violations.push({ path: filePath, line: index + 1, text: line.trim() });
    }
  });

  return violations;
}

function main() {
  const files = listWorkflowScripts(WORKFLOWS_DIR);

  if (files.length === 0) {
    console.log(`OK: no workflow scripts found under ${WORKFLOWS_DIR} — nothing to check.`);
    process.exit(0);
  }

  let failed = false;

  for (const file of files) {
    const syntaxError = checkSyntax(file);
    if (syntaxError) {
      console.error(`${file}: SYNTAX ERROR\n${syntaxError}`);
      failed = true;
      continue;
    }

    const unpinned = findUnpinnedAgentCalls(file);
    for (const violation of unpinned) {
      console.error(
        `${violation.path}:${violation.line} - agent() call not wrapped in pin(...) and not marked with a preceding "// no-pin: <reason>" comment:\n    ${violation.text}`
      );
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`OK: ${files.length} workflow script(s) checked — syntax valid, all agent() calls pinned.`);
  process.exit(0);
}

main();
