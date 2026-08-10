/**
 * Renders scenario results as a paste-ready markdown table and resolves the
 * process exit code for the load-test CLI (issue #81).
 */

import type { ScenarioResult, ScenarioStatus } from "./scenarios";

function statusCell(status: ScenarioStatus): string {
  switch (status) {
    case "pass":
      return "Pass";
    case "fail":
      return "Fail";
    case "skipped":
      return "Not run";
    case "blocked":
      return "Blocked";
  }
}

// host-only — no query string, no credentials (a base URL never carries a
// token, but this keeps the report format defensively minimal regardless).
function hostOnly(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.split("?")[0] ?? baseUrl;
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * `| Target | Threshold | Measured (p95) | Status | Notes |` — paste-ready
 * into documentation/performance-testing.md §7.
 */
export function renderMarkdown(
  results: readonly ScenarioResult[],
  meta: { baseUrl: string; startedAt: string },
): string {
  const lines: string[] = [];
  lines.push(`Load test run — ${hostOnly(meta.baseUrl)} — ${meta.startedAt}`);
  lines.push("");
  lines.push("| Target | Threshold | Measured (p95) | Status | Notes |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const result of results) {
    lines.push(
      `| ${escapeCell(result.label)} | ${escapeCell(result.targetLabel)} | ${escapeCell(result.measured)} | ${statusCell(result.status)} | ${escapeCell(result.detail)} |`,
    );
  }

  return lines.join("\n");
}

/**
 * 0: every executed scenario passed (none skipped/blocked).
 * 1: at least one scenario failed.
 * 3: no failures, but at least one scenario was skipped or blocked (an
 *    incomplete pass). (2 — partial/invalid env or preflight failure — is
 *    resolved by run.ts before any scenario runs, not here.)
 */
export function resolveExitCode(results: readonly ScenarioResult[]): 0 | 1 | 3 {
  if (results.some((result) => result.status === "fail")) return 1;
  if (results.some((result) => result.status === "skipped" || result.status === "blocked"))
    return 3;
  return 0;
}
