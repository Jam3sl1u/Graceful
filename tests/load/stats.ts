/**
 * Pure percentile / summary / threshold-evaluation logic for the load-test
 * harness (issue #81). No I/O — kept pure so it is trivially unit-testable
 * under `bun run test` (tests/unit/load/stats.test.ts).
 */

import { LOAD_PROFILE } from "./targets";

export type LatencySummary = {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

/**
 * Nearest-rank percentile on an ascending copy of `samples`.
 * index = clamp(ceil(p/100 * n) - 1, 0, n - 1). Returns null when empty.
 */
export function percentile(samples: readonly number[], p: number): number | null {
  const n = samples.length;
  if (n === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const rawIndex = Math.ceil((p / 100) * n) - 1;
  const index = Math.min(Math.max(rawIndex, 0), n - 1);
  const value = sorted[index];
  return value ?? null;
}

export function summarize(samples: readonly number[]): LatencySummary | null {
  const count = samples.length;
  if (count === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);

  // Unreachable given count > 0 above, but satisfies noUncheckedIndexedAccess
  // without a non-null assertion.
  if (min === undefined || max === undefined || p50 === null || p95 === null || p99 === null) {
    return null;
  }

  const sum = samples.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;

  return { count, min, p50, p95, p99, max, mean };
}

export type ThresholdResult =
  { status: "pass"; p95: number } | { status: "fail"; p95: number | null; reason: string };

/**
 * Fails (never passes) when: `summary` is null / zero samples; p95 exceeds
 * `thresholdMs`; or the non-rate-limited error rate exceeds `maxErrorRate`.
 * `counters.rateLimited` is excluded from both the latency samples (by the
 * caller) and this error-rate computation.
 */
export function evaluateThreshold(
  summary: LatencySummary | null,
  thresholdMs: number,
  counters: { ok: number; rateLimited: number; errors: number },
  maxErrorRate: number = LOAD_PROFILE.maxErrorRate,
): ThresholdResult {
  if (summary === null || summary.count === 0) {
    return { status: "fail", p95: null, reason: "no successful samples recorded" };
  }

  const nonRateLimitedTotal = counters.ok + counters.errors;
  const errorRate = nonRateLimitedTotal > 0 ? counters.errors / nonRateLimitedTotal : 0;

  if (errorRate > maxErrorRate) {
    return {
      status: "fail",
      p95: summary.p95,
      reason: `non-429 error rate ${(errorRate * 100).toFixed(1)}% exceeds max ${(maxErrorRate * 100).toFixed(1)}%`,
    };
  }

  if (summary.p95 > thresholdMs) {
    return {
      status: "fail",
      p95: summary.p95,
      reason: `p95 ${summary.p95}ms exceeds threshold ${thresholdMs}ms`,
    };
  }

  return { status: "pass", p95: summary.p95 };
}
