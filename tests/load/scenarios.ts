/**
 * The four load-test scenarios (issue #81, PRD §14.1). Orchestrates
 * tests/load/http.ts + tests/load/stats.ts against tests/load/targets.ts's
 * registry/profile. No jest — these scenarios make real network calls and
 * are exercised by a real `bun run test:load` pass against staging, not by
 * `bun run test` (see .pipeline/spec.md §2, no unit test file is listed for
 * this module).
 */

import { runConcurrent, timedRequest } from "./http";
import { evaluateThreshold, summarize, type LatencySummary } from "./stats";
import {
  API_ENDPOINTS,
  EXPECTED_RATE_LIMIT_POLICIES,
  LOAD_PROFILE,
  NOTIFICATION_PROFILE,
  PERF_TARGETS,
  type Persona,
} from "./targets";
import type { LoadTestConfig } from "./env";

// See the rateLimited branch in runLoadAgainstEndpoints's task below for why
// this is capped rather than honoring the server's full Retry-After.
const RATE_LIMIT_BACKOFF_CAP_MS = 2000;

/**
 * Backoff duration (ms) for a rate-limited outcome: the server's
 * `Retry-After` (seconds, floored to 1 if it parses as <=0), capped at
 * `RATE_LIMIT_BACKOFF_CAP_MS`. A missing or non-numeric `retryAfter` (e.g.
 * an HTTP-date form, or absent) falls back to the cap outright.
 */
export function resolveBackoffMs(retryAfter: string | null): number {
  const parsedRetryAfter = retryAfter ? Number(retryAfter) : NaN;
  return Number.isFinite(parsedRetryAfter)
    ? Math.min(Math.max(1, parsedRetryAfter) * 1000, RATE_LIMIT_BACKOFF_CAP_MS)
    : RATE_LIMIT_BACKOFF_CAP_MS;
}

export type ScenarioStatus = "pass" | "fail" | "skipped" | "blocked";

export type ScenarioResult = {
  id: string; // "api" | "signed-url" | "rate-limit" | "notifications"
  label: string;
  targetLabel: string; // e.g. "p95 < 500ms"
  status: ScenarioStatus;
  measured: string; // e.g. "412ms" or "—"
  detail: string; // reason / per-endpoint breakdown / block reason
  perEndpoint?: {
    name: string;
    summary: LatencySummary | null;
    ok: number;
    rateLimited: number;
    errors: number;
  }[];
};

function tokenForPersona(config: LoadTestConfig, persona: Persona): string | null {
  if (persona === "none") return null;
  const tokens = persona === "admin" ? config.adminTokens : config.memberTokens;
  return tokens[0] ?? null;
}

function tokensForPersona(config: LoadTestConfig, persona: Persona): string[] {
  if (persona === "none") return [];
  return persona === "admin" ? config.adminTokens : config.memberTokens;
}

function measuredLabel(p95: number | null): string {
  return p95 === null ? "—" : `${Math.round(p95)}ms`;
}

async function preflightOne(
  config: LoadTestConfig,
  name: string,
  path: string,
  persona: Persona,
): Promise<string | null> {
  const token = tokenForPersona(config, persona);
  const url = `${config.baseUrl}${path}`;

  let outcome = await timedRequest(url, {
    method: "GET",
    token,
    timeoutMs: LOAD_PROFILE.requestTimeoutMs,
  });

  if (outcome.classification === "rateLimited") {
    const parsedRetryAfter = outcome.retryAfter ? Number(outcome.retryAfter) : NaN;
    const waitSeconds = Number.isFinite(parsedRetryAfter) ? Math.max(1, parsedRetryAfter) : 1;
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    outcome = await timedRequest(url, {
      method: "GET",
      token,
      timeoutMs: LOAD_PROFILE.requestTimeoutMs,
    });
  }

  if (outcome.status < 200 || outcome.status >= 300) {
    return `${name}: HTTP ${outcome.status}`;
  }
  return null;
}

/**
 * One request per API_ENDPOINTS entry (plus the signed-URL endpoint when
 * songId is set), using the persona's first token. Doubles as warm-up so
 * Vercel cold starts do not skew p95 in the load scenarios that follow.
 */
export async function preflight(
  config: LoadTestConfig,
): Promise<{ ok: true } | { ok: false; failures: string[] }> {
  const failures: string[] = [];

  for (const endpoint of API_ENDPOINTS) {
    const failure = await preflightOne(config, endpoint.name, endpoint.path, endpoint.persona);
    if (failure) failures.push(failure);
  }

  if (config.songId) {
    const failure = await preflightOne(
      config,
      "GET /api/songs/:id/documents",
      `/api/songs/${config.songId}/documents`,
      "member",
    );
    if (failure) failures.push(failure);
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true };
}

// Set by runApiLoad, read by runRateLimitProbe — both scenarios execute
// sequentially within the same `bun run test:load` process (run.ts never
// runs scenarios in parallel), so a module-level handoff is sufficient and
// avoids widening either function's spec'd signature.
let lastApiLoadRateLimitedTotal: number | null = null;

export type EndpointAggregate = {
  name: string;
  samples: number[];
  ok: number;
  rateLimited: number;
  errors: number;
  unauthorized: number;
};

/**
 * Pools per-endpoint aggregates into the overall sample set used for the
 * AC1 p95/error-rate evaluation. `persona: "none"` endpoints (currently only
 * `GET /api/health`) are exempt from rate limiting and unauthenticated
 * (`resolveTier`, `lib/api/rate-limit.ts`), so their sample volume and error
 * rate are not representative of the authenticated API under load and must
 * not be pooled into the AC1 measurement — every endpoint is still reported
 * individually in `perEndpoint` regardless of persona.
 */
export function poolAggregates(
  endpoints: readonly { name: string; persona: Persona }[],
  aggregates: ReadonlyMap<number, EndpointAggregate>,
): {
  overallSamples: number[];
  totalOk: number;
  totalRateLimited: number;
  totalErrors: number;
  perEndpoint: {
    name: string;
    summary: LatencySummary | null;
    ok: number;
    rateLimited: number;
    errors: number;
  }[];
} {
  const overallSamples: number[] = [];
  let totalOk = 0;
  let totalRateLimited = 0;
  let totalErrors = 0;
  const perEndpoint: {
    name: string;
    summary: LatencySummary | null;
    ok: number;
    rateLimited: number;
    errors: number;
  }[] = [];

  endpoints.forEach((endpoint, index) => {
    const bucket = aggregates.get(index);
    if (!bucket) return;

    perEndpoint.push({
      name: bucket.name,
      summary: summarize(bucket.samples),
      ok: bucket.ok,
      rateLimited: bucket.rateLimited,
      errors: bucket.errors,
    });

    if (endpoint.persona === "none") return;

    overallSamples.push(...bucket.samples);
    totalOk += bucket.ok;
    totalRateLimited += bucket.rateLimited;
    totalErrors += bucket.errors;
  });

  return { overallSamples, totalOk, totalRateLimited, totalErrors, perEndpoint };
}

async function runLoadAgainstEndpoints(
  config: LoadTestConfig,
  endpoints: readonly { name: string; path: string; persona: Persona }[],
  pickEndpoint: (workerIndex: number, iteration: number) => number,
): Promise<{
  overallSamples: number[];
  totalOk: number;
  totalRateLimited: number;
  totalErrors: number;
  unauthorizedSeen: boolean;
  perEndpoint: {
    name: string;
    summary: LatencySummary | null;
    ok: number;
    rateLimited: number;
    errors: number;
  }[];
}> {
  const aggregates = new Map<number, EndpointAggregate>();
  endpoints.forEach((endpoint, index) => {
    aggregates.set(index, {
      name: endpoint.name,
      samples: [],
      ok: 0,
      rateLimited: 0,
      errors: 0,
      unauthorized: 0,
    });
  });

  let unauthorizedSeen = false;

  await runConcurrent(
    async (workerIndex, iteration) => {
      const endpointIndex = pickEndpoint(workerIndex, iteration);
      const endpoint = endpoints[endpointIndex];
      const bucket = aggregates.get(endpointIndex);
      if (!endpoint || !bucket) return;

      const tokens = tokensForPersona(config, endpoint.persona);
      const token = tokens.length > 0 ? (tokens[workerIndex % tokens.length] ?? null) : null;
      const url = `${config.baseUrl}${endpoint.path}`;
      const outcome = await timedRequest(url, {
        method: "GET",
        token,
        timeoutMs: LOAD_PROFILE.requestTimeoutMs,
      });

      if (outcome.classification === "ok") {
        bucket.ok += 1;
        bucket.samples.push(outcome.durationMs);
      } else if (outcome.classification === "rateLimited") {
        bucket.rateLimited += 1;
        // Back off before the next iteration so a throttled worker doesn't
        // immediately re-hammer the limiter — but capped, unlike
        // preflightOne's one-shot retry above: the server's own Retry-After
        // can be up to the full rate-limit window (documentation/performance-testing.md
        // §6 "Shared rate-limit bucket" — a small shared token pool hits this
        // routinely), and LOAD_PROFILE.durationSeconds is a fixed wall-clock
        // budget for the whole run. Honoring the full Retry-After here would
        // let one throttled worker stall the run for tens of seconds past
        // its own deadline; a short, bounded backoff still eases pressure
        // without breaking that contract.
        await new Promise((resolve) => setTimeout(resolve, resolveBackoffMs(outcome.retryAfter)));
      } else if (outcome.classification === "unauthorized") {
        bucket.unauthorized += 1;
        unauthorizedSeen = true;
      } else {
        bucket.errors += 1;
      }
    },
    {
      concurrency: LOAD_PROFILE.concurrentUsers,
      rampUpMs: LOAD_PROFILE.rampUpSeconds * 1000,
      durationMs: LOAD_PROFILE.durationSeconds * 1000,
      thinkTimeMs: LOAD_PROFILE.thinkTimeMs,
    },
  );

  const { overallSamples, totalOk, totalRateLimited, totalErrors, perEndpoint } = poolAggregates(
    endpoints,
    aggregates,
  );

  return { overallSamples, totalOk, totalRateLimited, totalErrors, unauthorizedSeen, perEndpoint };
}

/**
 * LOAD_PROFILE concurrency/duration/ramp-up. Worker `i` uses
 * `tokens[i % tokens.length]` for its persona; each iteration picks the next
 * endpoint round-robin. Aggregates per-endpoint and overall; evaluates
 * against PERF_TARGETS.api. Any `unauthorized` outcome fails the whole
 * scenario — a token that expires mid-run must never be reported as latency
 * data.
 */
export async function runApiLoad(config: LoadTestConfig): Promise<ScenarioResult> {
  const target = PERF_TARGETS.api;
  const targetLabel = `p95 < ${target.thresholdMs}ms`;
  const authenticatedEndpointCount = API_ENDPOINTS.filter((e) => e.persona !== "none").length;

  const { overallSamples, totalOk, totalRateLimited, totalErrors, unauthorizedSeen, perEndpoint } =
    await runLoadAgainstEndpoints(
      config,
      API_ENDPOINTS,
      (workerIndex, iteration) => (workerIndex + iteration) % API_ENDPOINTS.length,
    );

  lastApiLoadRateLimitedTotal = totalRateLimited;

  if (unauthorizedSeen) {
    return {
      id: "api",
      label: "API load",
      targetLabel,
      status: "fail",
      measured: "—",
      detail: "session token rejected (401/403) — re-mint LOAD_TEST_*_TOKENS and re-run",
      perEndpoint,
    };
  }

  const summary = summarize(overallSamples);
  const result = evaluateThreshold(summary, target.thresholdMs, {
    ok: totalOk,
    rateLimited: totalRateLimited,
    errors: totalErrors,
  });

  return {
    id: "api",
    label: "API load",
    targetLabel,
    status: result.status,
    measured: measuredLabel(result.p95),
    detail:
      result.status === "pass"
        ? `${totalOk} ok, ${totalRateLimited} rate-limited, ${totalErrors} errors across ${authenticatedEndpointCount} authenticated endpoints (GET /api/health excluded from AC1 pooling — see perEndpoint)`
        : result.reason,
    perEndpoint,
  };
}

/**
 * Same profile against GET /api/songs/<LOAD_TEST_SONG_ID>/documents (the
 * route that mints presigned R2 URLs), evaluated against
 * PERF_TARGETS.signedUrl. `skipped` when songId is null.
 */
export async function runSignedUrlLoad(config: LoadTestConfig): Promise<ScenarioResult> {
  const target = PERF_TARGETS.signedUrl;
  const targetLabel = `p95 < ${target.thresholdMs}ms`;

  if (!config.songId) {
    return {
      id: "signed-url",
      label: "Signed URL generation",
      targetLabel,
      status: "skipped",
      measured: "—",
      detail: "LOAD_TEST_SONG_ID not set — skipped",
    };
  }

  const endpoints = [
    {
      name: "GET /api/songs/:id/documents",
      path: `/api/songs/${config.songId}/documents`,
      persona: "member" as Persona,
    },
  ];

  const { overallSamples, totalOk, totalRateLimited, totalErrors, unauthorizedSeen } =
    await runLoadAgainstEndpoints(config, endpoints, () => 0);

  if (unauthorizedSeen) {
    return {
      id: "signed-url",
      label: "Signed URL generation",
      targetLabel,
      status: "fail",
      measured: "—",
      detail: "session token rejected (401/403) — re-mint LOAD_TEST_*_TOKENS and re-run",
    };
  }

  const summary = summarize(overallSamples);
  const result = evaluateThreshold(summary, target.thresholdMs, {
    ok: totalOk,
    rateLimited: totalRateLimited,
    errors: totalErrors,
  });

  return {
    id: "signed-url",
    label: "Signed URL generation",
    targetLabel,
    status: result.status,
    measured: measuredLabel(result.p95),
    detail:
      result.status === "pass"
        ? `${totalOk} ok, ${totalRateLimited} rate-limited, ${totalErrors} errors`
        : result.reason,
  };
}

/**
 * AC4. Using a single member token (one bucket), fires
 * EXPECTED_RATE_LIMIT_POLICIES.read.limit + 20 sequential requests to
 * /api/profile inside one window. Passes only when: at least one 429 is
 * observed, every 429 carries a Retry-After header parsing to an integer
 * >= 1, and every 429 body reports code === "RATE_LIMITED". Also reports (in
 * `detail`) the 429 count observed during runApiLoad in the same session —
 * the "under this same load test" half of AC4 — and fails if that count and
 * this probe's own count are both zero. Short-circuits once the pass
 * assertions are already satisfiable so the probe stays under a minute.
 */
export async function runRateLimitProbe(config: LoadTestConfig): Promise<ScenarioResult> {
  const policy = EXPECTED_RATE_LIMIT_POLICIES.read;
  const totalRequests = policy.limit + 20;
  const token = config.memberTokens[0] ?? null;
  const url = `${config.baseUrl}/api/profile`;

  let rateLimitedCount = 0;
  let sawInvalidRetryAfter = false;
  let sawInvalidCode = false;
  let requestsIssued = 0;

  for (let i = 0; i < totalRequests; i++) {
    requestsIssued = i + 1;
    const outcome = await timedRequest(url, {
      method: "GET",
      token,
      timeoutMs: LOAD_PROFILE.requestTimeoutMs,
    });

    if (outcome.classification === "rateLimited") {
      rateLimitedCount += 1;

      const parsedRetryAfter = outcome.retryAfter ? Number(outcome.retryAfter) : NaN;
      if (!Number.isInteger(parsedRetryAfter) || parsedRetryAfter < 1) {
        sawInvalidRetryAfter = true;
      }
      if (outcome.errorCode !== "RATE_LIMITED") {
        sawInvalidCode = true;
      }
    }

    const alreadySatisfiable = rateLimitedCount >= 1 && !sawInvalidRetryAfter && !sawInvalidCode;
    if (alreadySatisfiable && i + 1 >= policy.limit) {
      break;
    }
  }

  const apiLoadNote =
    lastApiLoadRateLimitedTotal === null
      ? "runApiLoad rate-limited count: not run this session"
      : `runApiLoad rate-limited count: ${lastApiLoadRateLimitedTotal}`;

  const bothZero = rateLimitedCount === 0 && (lastApiLoadRateLimitedTotal ?? 0) === 0;
  const passed = rateLimitedCount >= 1 && !sawInvalidRetryAfter && !sawInvalidCode && !bothZero;

  const reasons: string[] = [];
  if (rateLimitedCount === 0) reasons.push("no 429 observed");
  if (sawInvalidRetryAfter)
    reasons.push("a 429 was missing a valid Retry-After header (integer >= 1)");
  if (sawInvalidCode) reasons.push('a 429 body did not report code === "RATE_LIMITED"');
  if (bothZero && rateLimitedCount === 0)
    reasons.push("runApiLoad also produced zero 429s this session");

  const detail = `${rateLimitedCount} of ${requestsIssued} requests to /api/profile were 429 (policy: ${policy.limit}/${policy.windowMs / 1000}s). ${apiLoadNote}.${reasons.length > 0 ? ` ${reasons.join("; ")}.` : ""}`;

  return {
    id: "rate-limit",
    label: "Rate limit probe",
    targetLabel: '>=1 429 with valid Retry-After and code="RATE_LIMITED" (AC4)',
    status: passed ? "pass" : "fail",
    measured: `${rateLimitedCount} 429s`,
    detail,
  };
}

/**
 * Always `blocked`, no network calls, no fabricated numbers — see
 * .pipeline/spec.md OPEN QUESTION 1.
 */
export async function runNotificationLatency(): Promise<ScenarioResult> {
  const sms = PERF_TARGETS.sms;
  const email = PERF_TARGETS.email;

  return {
    id: "notifications",
    label: "Notification delivery latency",
    targetLabel: `SMS p95 < ${sms.thresholdMs / 1000}s, email p95 < ${email.thresholdMs / 1000}s @ ${NOTIFICATION_PROFILE.simultaneousSends} simultaneous sends`,
    status: "blocked",
    measured: "—",
    detail:
      "Blocked: sendSms (lib/pingram/client.ts:5) and sendEmail (lib/resend/client.ts:4) are " +
      "unimplemented stubs that always throw; the Pingram/Resend delivery webhooks " +
      "(app/api/webhooks/pingram/route.ts, app/api/webhooks/resend/route.ts) are 501 stubs; and " +
      "the notifications table has no dispatch/delivery timestamp columns " +
      "(supabase/migrations/20260702000005_cluster_5_partial.sql:59). There is nothing to time — " +
      "no network calls were made and no latency number was fabricated.",
  };
}
