#!/usr/bin/env bun
/**
 * CLI entry point for the load-test harness (issue #81, PRD §14.1).
 *
 *   bun run test:load [--scenario api|signed-url|rate-limit|notifications|all] [--markdown]
 *
 * Never writes to any file — prints a human summary always, and the
 * markdown table (documentation/performance-testing.md §7 paste target)
 * when --markdown is passed. See documentation/performance-testing.md for
 * the exit-code table and required env vars.
 */

import { spawnSync } from "node:child_process";

import { readEnv } from "./env";
import {
  preflight,
  runApiLoad,
  runNotificationLatency,
  runRateLimitProbe,
  runSignedUrlLoad,
  type ScenarioResult,
} from "./scenarios";
import { renderMarkdown, resolveExitCode } from "./report";
import type { LoadTestConfig } from "./env";

type SingleScenario = "api" | "signed-url" | "rate-limit" | "notifications";
type ScenarioName = SingleScenario | "all";

const SCENARIO_ORDER: readonly SingleScenario[] = [
  "api",
  "signed-url",
  "rate-limit",
  "notifications",
];

function isSingleScenario(value: string): value is SingleScenario {
  return (SCENARIO_ORDER as readonly string[]).includes(value);
}

/**
 * Short SHA of the harness's own local checkout — i.e. which version of
 * tests/load/** produced this row, not which commit is deployed to the
 * staging server being measured (those routinely differ; the operator's
 * checkout may also be ahead of or behind what's actually deployed). A
 * `-dirty` suffix flags an uncommitted working tree, since that SHA alone
 * would otherwise overstate how reproducible the run is.
 */
function resolveCommit(): string {
  try {
    const shaResult = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const sha = shaResult.stdout?.trim() ?? "";
    if (sha.length === 0) return "unknown";

    const statusResult = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    const isDirty = (statusResult.stdout?.trim() ?? "").length > 0;
    return isDirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

function parseArgs(argv: readonly string[]): { scenario: ScenarioName; markdown: boolean } {
  let scenario: ScenarioName = "all";
  let markdown = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenario") {
      const value = argv[i + 1];
      if (value === "all" || (value !== undefined && isSingleScenario(value))) {
        scenario = value;
        i += 1;
      } else {
        throw new Error(`Invalid --scenario value: ${value ?? "(missing)"}`);
      }
    } else if (arg === "--markdown") {
      markdown = true;
    }
  }

  return { scenario, markdown };
}

function runScenario(name: SingleScenario, config: LoadTestConfig): Promise<ScenarioResult> {
  switch (name) {
    case "api":
      return runApiLoad(config);
    case "signed-url":
      return runSignedUrlLoad(config);
    case "rate-limit":
      return runRateLimitProbe(config);
    case "notifications":
      return runNotificationLatency();
  }
}

function printSummary(results: readonly ScenarioResult[]): void {
  console.log("\nLoad test results:");
  for (const result of results) {
    console.log(
      `  [${result.status.toUpperCase()}] ${result.label} — target ${result.targetLabel} — measured ${result.measured}`,
    );
    console.log(`    ${result.detail}`);
    if (result.perEndpoint) {
      for (const endpoint of result.perEndpoint) {
        const p95 = endpoint.summary ? `${Math.round(endpoint.summary.p95)}ms` : "—";
        console.log(
          `      ${endpoint.name}: p95=${p95} ok=${endpoint.ok} rateLimited=${endpoint.rateLimited} errors=${endpoint.errors}`,
        );
      }
    }
  }
  console.log("");
}

async function main(): Promise<void> {
  const { scenario, markdown } = parseArgs(process.argv.slice(2));
  const env = readEnv();

  if (env.kind === "unconfigured") {
    console.log("SKIPPED: load harness not configured (see documentation/performance-testing.md)");
    process.exit(0);
    return;
  }

  if (env.kind === "partial") {
    console.error(`Load harness env is partially configured. Missing: ${env.missing.join(", ")}`);
    console.error("See documentation/performance-testing.md for required variables.");
    process.exit(2);
    return;
  }

  const { config } = env;
  console.log(
    `Running load test against ${config.baseUrl} (run against staging, not local dev)...`,
  );

  // The notifications scenario makes zero network calls (runNotificationLatency
  // always returns blocked), so warming up/probing the API endpoints ahead of
  // it wastes 13 requests for no benefit. Only skip when it's the sole
  // scenario being run — inside `--scenario all`, the other 3 scenarios still
  // need the warm-up and notifications runs last anyway.
  const needsPreflight = scenario !== "notifications";
  if (needsPreflight) {
    const preflightResult = await preflight(config);
    if (!preflightResult.ok) {
      console.error("Preflight failed:");
      for (const failure of preflightResult.failures) {
        console.error(`  - ${failure}`);
      }
      process.exit(2);
      return;
    }
  }

  const toRun: readonly SingleScenario[] = scenario === "all" ? SCENARIO_ORDER : [scenario];
  const results: ScenarioResult[] = [];
  const startedAt = new Date().toISOString();

  // Sequential, never parallel — a parallel scenario would contend for the
  // same rate-limit bucket and corrupt both measurements.
  for (const name of toRun) {
    const result = await runScenario(name, config);
    results.push(result);
  }

  printSummary(results);

  if (markdown) {
    console.log(
      renderMarkdown(results, { baseUrl: config.baseUrl, startedAt, commit: resolveCommit() }),
    );
  }

  process.exit(resolveExitCode(results));
}

main().catch((err: unknown) => {
  console.error("Load test run failed:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
