# Spec — Issue #81: [Sprint 4] Run performance/load test pass against staging

PRD reference: Phase 1 PRD §14.1 (Performance Requirements). Backlog row 72.
Blocks #83 (production deploy gate).

## OPEN QUESTIONS

**None are blocking. Each item below has a decided default — implement the
default. They are recorded here (and must be recorded in the delivered doc) so
a human can overrule them later.**

1. **AC2 (notification delivery latency) cannot be measured today.**
   `sendSms` (`lib/pingram/client.ts:5`) and `sendEmail`
   (`lib/resend/client.ts:4`) are unimplemented stubs that always throw, the
   Pingram/Resend delivery webhooks are 501 stubs
   (`app/api/webhooks/pingram/route.ts`, `app/api/webhooks/resend/route.ts`),
   and the `notifications` table has no dispatch/delivery timestamp columns
   (`supabase/migrations/20260702000005_cluster_5_partial.sql:59`). There is
   nothing to time.
   **Decided default:** implement the notification-latency scenario as an
   explicit `blocked` result that performs no network calls and names those
   files as the reason. Do **not** synthesize, estimate, or fake a latency
   number. Record it in the results table as `Blocked` (blocked by the SMS and
   email integration issues). This makes the harness's exit code non-zero
   (code 3, see §5) so the pass cannot be mistaken for complete.

2. **"100 concurrent users" vs. per-identity rate limiting.** The limiter keys
   per Clerk user id (`getRequestIdentifier`, `lib/api/rate-limit.ts:101`) with
   `read` at 240/min and `write` at 60/min, and staging seeds exactly two Clerk
   test users (`E2E_ADMIN_EMAIL` / `E2E_MEMBER_EMAIL`,
   `documentation/staging-environment.md` §7). 100 virtual users driven by one
   or two session tokens therefore share one or two buckets and will be
   throttled — which is itself what AC4 wants to see, but it means the p95
   figure is "latency under 100 concurrent in-flight requests", not "100
   distinct users' sustained traffic".
   **Decided default:** accept comma-separated *lists* of session tokens
   (§3.1) so the operator can widen the identity pool later with zero code
   change; compute p95 over non-429 responses only; state this limitation
   verbatim in the delivered doc.

## 1. Scope

In scope: a committed, runnable load-test harness targeting staging, plus the
documentation and the results table the human operator fills in when they run
the pass.

Out of scope (do not implement): more than 100 concurrent users; any CI
workflow change (`.github/workflows/ci.yml` must not be modified — there is no
staging-secret-bearing job for this and network load tests do not belong in
the per-PR `checks` job); any change to application code under `app/**`,
`lib/**`, `middleware.ts`, `schemas/**`, or `supabase/**`; implementing SMS or
email dispatch; a results-gate script (issue #83 consumes the doc's table).

**Tool choice (not an open question).** The AC says "k6 (or similar)". Use a
Bun + TypeScript harness, not k6: k6 is a Go binary that is not installable
through Bun, its scripts cannot import this repo's TypeScript, and a
hand-rolled harness keeps the percentile/threshold/report logic in plain
modules that the existing Jest suite can unit-test. State this rationale in the
delivered doc.

## 2. Files

Create:

| Path | Purpose |
| --- | --- |
| `tests/load/env.ts` | Env-var gating (copy the shape of `tests/e2e/support/env.ts`) |
| `tests/load/targets.ts` | Targets, load profile, endpoint registry, expected rate-limit policies |
| `tests/load/stats.ts` | Pure percentile / summary / threshold-evaluation logic |
| `tests/load/http.ts` | Timed fetch + bounded-concurrency runner |
| `tests/load/scenarios.ts` | The four scenarios (api, signed-url, rate-limit, notifications) |
| `tests/load/report.ts` | Renders results as a markdown table + exit-code resolution |
| `tests/load/run.ts` | CLI entry point |
| `tests/unit/load/stats.test.ts` | Unit tests for `stats.ts` |
| `tests/unit/load/targets.test.ts` | Unit tests for `targets.ts` (incl. the rate-limit-policy sync check) |
| `tests/unit/load/http.test.ts` | Unit tests for `runConcurrent` / classification |
| `tests/unit/load/report.test.ts` | Unit tests for report rendering + exit codes |
| `documentation/performance-testing.md` | The pass's documentation + results table |

Modify:

| Path | Change |
| --- | --- |
| `package.json` | Add `"test:load": "bun run tests/load/run.ts"` to `scripts` (place after `test:e2e`) |
| `README.md` | One `See [documentation/performance-testing.md](...)` line alongside the existing `documentation/...` links (~line 14) |
| `documentation/staging-environment.md` | New `## 9. Load / performance testing (issue #81)` section: the env vars from §3.1 and a pointer to `documentation/performance-testing.md`. Do not renumber existing sections. |

Constraints on `tests/load/**`:

- Plain TypeScript executed by Bun. Must **not** import `server-only`,
  `next/server`, `@clerk/*`, `@supabase/*`, or anything under `app/**` or
  `lib/**` (those pull server-only/Next runtime bundles into a bare Bun
  process). Use the global `fetch` only.
- `tests/load/**` is not matched by `jest.config.js` `testMatch`
  (`tests/unit/**` only) or `jest.config.integration.js`, so no config change
  is needed — do not add one.
- Must pass `bun run typecheck` under `strict` + `noUncheckedIndexedAccess`,
  `bun run lint`, and `bun run format:check`. No `any`, no eslint-disable, no
  new eslint ignore entries.

## 3. Interfaces

### 3.1 `tests/load/env.ts`

Copy the doc-comment + `REQUIRED_VARS` + `requireEnv` structure of
`tests/e2e/support/env.ts`.

```ts
export type LoadTestConfig = {
  baseUrl: string;            // trailing slash stripped
  adminTokens: string[];      // >= 1
  memberTokens: string[];     // >= 1
  songId: string | null;      // LOAD_TEST_SONG_ID, null when unset
};

/** "unconfigured" = none of the vars set; "partial" = some but not all. */
export type EnvState =
  | { kind: "configured"; config: LoadTestConfig }
  | { kind: "unconfigured" }
  | { kind: "partial"; missing: string[] };

export function readEnv(env?: NodeJS.ProcessEnv): EnvState;
```

Variables:

| Var | Required | Meaning |
| --- | --- | --- |
| `LOAD_TEST_BASE_URL` | yes (falls back to `STAGING_APP_URL`) | Staging base URL |
| `LOAD_TEST_ADMIN_TOKENS` | yes | Comma-separated Clerk session JWTs for admin-persona user(s) |
| `LOAD_TEST_MEMBER_TOKENS` | yes | Comma-separated Clerk session JWTs for member-persona user(s) |
| `LOAD_TEST_SONG_ID` | no | Song uuid with ≥1 attached document; signed-URL scenario is `skipped` when absent |

Token lists: split on `,`, trim, drop empties. Tokens are sent as
`Authorization: Bearer <token>`. **Never log, print, or write a token value**
(including in error messages and the markdown report) — `check:git-secrets`
runs in CI and a leaked JWT in a committed artifact is a security incident.

### 3.2 `tests/load/targets.ts`

```ts
export type PerfTarget = {
  id: "api" | "signedUrl" | "sms" | "email";
  label: string;
  thresholdMs: number;   // p95
  criterion: string;     // the AC sentence this comes from
};

export const PERF_TARGETS: Readonly<Record<PerfTarget["id"], PerfTarget>>;
// api 500, signedUrl 200, sms 30_000, email 60_000

export const LOAD_PROFILE = {
  concurrentUsers: 100,
  durationSeconds: 60,
  rampUpSeconds: 10,
  requestTimeoutMs: 30_000,
  maxErrorRate: 0.01,     // >1% non-429 error responses ⇒ run invalid
} as const;

export const NOTIFICATION_PROFILE = { simultaneousSends: 50 } as const;

export type Persona = "none" | "member" | "admin";
export type EndpointScenario = { name: string; method: "GET"; path: string; persona: Persona };
export const API_ENDPOINTS: readonly EndpointScenario[];

/** Mirrors RATE_LIMIT_POLICIES in lib/api/rate-limit.ts; kept in sync by a unit test. */
export const EXPECTED_RATE_LIMIT_POLICIES: Readonly<
  Record<"webhook" | "read" | "write" | "auth" | "invite" | "sms", { limit: number; windowMs: number }>
>;
```

`API_ENDPOINTS` — implemented GET routes with no required query params. Every
one below was verified to exist and not be a `notImplemented` stub; set
`persona` from each handler's own `requireRole(...)` call and use `admin` when
unsure (an admin token satisfies every route):

| path | persona |
| --- | --- |
| `/api/health` | `none` |
| `/api/profile` | `member` |
| `/api/church-group/members` | `member` |
| `/api/songs` | `member` |
| `/api/service-weeks` | `member` |
| `/api/events` | `member` |
| `/api/availability` | `member` |
| `/api/notifications/preferences` | `member` |
| `/api/conflicts` | `admin` |
| `/api/service-weeks/overview` | `admin` |
| `/api/church-group/audit-log` | `admin` |
| `/api/instruments` | `admin` |

Do **not** add `/api/church-group`, `/api/notifications`,
`/api/notifications/unread-count`, or any `/api/webhooks/*` route — they are
`notImplemented` 501 stubs today.

### 3.3 `tests/load/stats.ts`

```ts
export type LatencySummary = {
  count: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number;
};

/** Nearest-rank on an ascending copy: index = clamp(ceil(p/100 * n) - 1, 0, n-1). Returns null when empty. */
export function percentile(samples: readonly number[], p: number): number | null;
export function summarize(samples: readonly number[]): LatencySummary | null;

export type ThresholdResult =
  | { status: "pass"; p95: number }
  | { status: "fail"; p95: number | null; reason: string };

export function evaluateThreshold(
  summary: LatencySummary | null,
  thresholdMs: number,
  counters: { ok: number; rateLimited: number; errors: number },
  maxErrorRate?: number,   // defaults to LOAD_PROFILE.maxErrorRate
): ThresholdResult;
```

`evaluateThreshold` fails (never passes) when: `summary` is `null` / zero
samples; `p95 > thresholdMs`; or `errors / (ok + errors) > maxErrorRate`.
`rateLimited` is excluded from both the latency samples and the error rate.

### 3.4 `tests/load/http.ts`

```ts
export type RequestOutcome = {
  status: number;             // 0 when the request threw / timed out
  durationMs: number;
  classification: "ok" | "rateLimited" | "unauthorized" | "error";
  retryAfter: string | null;  // Retry-After header, 429s only
  errorCode: string | null;   // parsed `code` from the ApiError JSON body, best effort
};

export async function timedRequest(
  url: string,
  init: { method: string; token: string | null; timeoutMs: number },
): Promise<RequestOutcome>;

export type ConcurrentOptions = {
  concurrency: number;
  rampUpMs?: number;
  durationMs?: number;   // exactly one of durationMs / iterationsPerWorker
  iterationsPerWorker?: number;
  now?: () => number;    // injectable for tests; defaults to performance.now
  sleep?: (ms: number) => Promise<void>; // injectable for tests
};

/** Runs `task(workerIndex, iteration)` with at most `concurrency` in flight. */
export async function runConcurrent<T>(
  task: (workerIndex: number, iteration: number) => Promise<T>,
  options: ConcurrentOptions,
): Promise<T[]>;
```

Classification: 2xx/3xx → `ok`; 429 → `rateLimited`; 401/403 → `unauthorized`;
everything else, plus throws/timeouts → `error`. Timeouts via `AbortController`.
Timing with `performance.now()` around the full request including body read.

### 3.5 `tests/load/scenarios.ts`

```ts
export type ScenarioStatus = "pass" | "fail" | "skipped" | "blocked";

export type ScenarioResult = {
  id: string;                       // "api" | "signed-url" | "rate-limit" | "notifications"
  label: string;
  targetLabel: string;              // e.g. "p95 < 500ms"
  status: ScenarioStatus;
  measured: string;                 // e.g. "412ms" or "—"
  detail: string;                   // reason / per-endpoint breakdown / block reason
  perEndpoint?: { name: string; summary: LatencySummary | null; ok: number; rateLimited: number; errors: number }[];
};

export async function preflight(config: LoadTestConfig): Promise<{ ok: true } | { ok: false; failures: string[] }>;
export async function runApiLoad(config: LoadTestConfig): Promise<ScenarioResult>;
export async function runSignedUrlLoad(config: LoadTestConfig): Promise<ScenarioResult>;
export async function runRateLimitProbe(config: LoadTestConfig): Promise<ScenarioResult>;
export async function runNotificationLatency(): Promise<ScenarioResult>;  // always "blocked", no network
```

- `preflight` — one request per `API_ENDPOINTS` entry (plus the signed-URL
  endpoint when `songId` is set) using the persona's first token. Any non-2xx
  is a failure entry (`"<name>: HTTP <status>"`); a 429 is retried once after
  its `Retry-After` before being treated as a failure. Preflight results are
  **not** included in the latency samples — it doubles as warm-up so Vercel
  cold starts do not skew p95.
- `runApiLoad` — `LOAD_PROFILE` concurrency/duration/ramp-up. Worker `i` uses
  `tokens[i % tokens.length]` for its persona; each iteration picks the next
  endpoint round-robin. Aggregates per-endpoint and overall; evaluates against
  `PERF_TARGETS.api`. Any `unauthorized` outcome ⇒ `fail` with
  `"session token rejected (401/403) — re-mint LOAD_TEST_*_TOKENS and re-run"`
  (a token that expires mid-run must never be reported as latency data).
- `runSignedUrlLoad` — same profile against
  `GET /api/songs/<LOAD_TEST_SONG_ID>/documents` (the route that mints presigned
  R2 URLs, `app/api/songs/[id]/documents/handler.ts` → `getDownloadUrl`),
  evaluated against `PERF_TARGETS.signedUrl`. `skipped` when `songId` is null.
- `runRateLimitProbe` — AC4. Using a single member token (one bucket), fire
  `EXPECTED_RATE_LIMIT_POLICIES.read.limit + 20` sequential requests to
  `/api/profile` inside one window. Passes only when: at least one 429 is
  observed, every 429 carries a `Retry-After` header parsing to an integer ≥ 1,
  and every 429 body reports `code === "RATE_LIMITED"`. Additionally report
  (in `detail`) the 429 counts observed during `runApiLoad` — that is the
  "under this same load test" half of AC4 — and fail if `runApiLoad` produced
  zero 429s *and* the probe produced zero 429s. Accept the result being reached
  before the full request count (short-circuit once the 429 assertions are
  satisfiable) so the probe stays under a minute.
- `runNotificationLatency` — returns `status: "blocked"`, `measured: "—"`, and
  a `detail` naming `lib/pingram/client.ts`, `lib/resend/client.ts`, the two
  501 webhook routes, and the missing delivery timestamp column, plus the
  `NOTIFICATION_PROFILE.simultaneousSends` / SMS 30s / email 60s targets it
  would have checked. No network calls, no fabricated numbers.

### 3.6 `tests/load/report.ts`

```ts
export function renderMarkdown(results: readonly ScenarioResult[], meta: { baseUrl: string; startedAt: string }): string;
export function resolveExitCode(results: readonly ScenarioResult[]): 0 | 1 | 3;
```

`renderMarkdown` emits a table with columns
`| Target | Threshold | Measured (p95) | Status | Notes |` — paste-ready into
`documentation/performance-testing.md` §7. Status cell values: `Pass`, `Fail`,
`Not run`, `Blocked`. `meta.baseUrl` is printed host-only (no query/credentials).

### 3.7 `tests/load/run.ts`

CLI: `bun run test:load [--scenario api|signed-url|rate-limit|notifications|all] [--markdown]`.
Default `--scenario all`. Runs scenarios sequentially (never in parallel — a
parallel scenario would contend for the same rate-limit bucket and corrupt both
measurements). Prints a human summary always; prints the markdown table when
`--markdown` is passed. Never writes to any file.

## 4. Edge cases the implementation must handle

1. Zero successful samples (every request errored) ⇒ `fail` with a stated
   reason — never a `p95` of `0` or `NaN`.
2. `noUncheckedIndexedAccess`: indexed reads are `T | undefined`; handle
   explicitly rather than with `!`.
3. 429s are excluded from latency samples *and* from the error rate, but are
   counted and reported.
4. Non-429 error rate above `LOAD_PROFILE.maxErrorRate` (1%) invalidates the
   run ⇒ `fail`, regardless of the p95 value.
5. Any 401/403 during a load scenario ⇒ `fail` ("expired/invalid session
   token"), never silently averaged in.
6. Per-request timeout (`requestTimeoutMs`), enforced with `AbortController`;
   a timed-out request is an `error`, and its duration is not a latency sample.
7. Env unset entirely ⇒ print `SKIPPED: load harness not configured (see
   documentation/performance-testing.md)` and exit `0`. Env partially set ⇒
   list the missing vars and exit `2`. Preflight failure ⇒ exit `2`.
8. Concurrency is a hard ceiling: never more than `concurrentUsers` requests in
   flight; ramp-up staggers worker start times across `rampUpSeconds`.
9. `LOAD_TEST_SONG_ID` unset ⇒ signed-URL scenario `skipped`, run exits `3`
   (incomplete), not `0`.
10. Fewer tokens than workers is normal and supported (workers share tokens);
    an empty token list is a `partial` env error.
11. Base URL with a trailing slash, or with a path, must not produce `//` in
    request URLs.
12. Tokens must never appear in stdout, the markdown report, or error strings.

## 5. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Env unconfigured (skip), or every executed scenario `pass` with none skipped/blocked |
| 1 | At least one scenario `fail` |
| 2 | Partial/invalid env, or preflight failure |
| 3 | No failures, but ≥1 scenario `skipped` or `blocked` (pass is incomplete) |

## 6. `documentation/performance-testing.md`

Follow the tone/structure of `documentation/staging-environment.md`
(numbered `##` sections, tables, explicit human-setup steps). Required
sections:

1. **Purpose** — PRD §14.1, issue #81, gates #83.
2. **Targets** — table: API p95 < 500ms @ 100 concurrent users; signed-URL
   generation p95 < 200ms; SMS delivery p95 < 30s @ 50 simultaneous sends;
   email delivery p95 < 60s @ 50 simultaneous sends. Cite the AC line for each.
3. **Harness** — why Bun/TypeScript instead of k6 (§1), file map, and the note
   that the pure logic is unit-tested under `bun run test`.
4. **Prerequisites** — the §3.1 env vars, how to obtain a Clerk session JWT for
   the seeded staging test users (`documentation/staging-environment.md` §7),
   the fact that Clerk session tokens are short-lived so they must be minted
   immediately before a run and re-minted if the run reports 401/403, and how
   to pick `LOAD_TEST_SONG_ID`. Use placeholders like `<clerk-session-jwt>` —
   never a real-looking token value.
5. **Running it** — `bun run test:load`, the `--scenario` / `--markdown` flags,
   the exit-code table from §5, and "run against staging, not local dev".
6. **Known limitations** — verbatim: the shared-rate-limit-bucket effect from
   OPEN QUESTION 2; the limiter being in-memory per instance
   (`lib/api/rate-limit.ts:123`) so a multi-instance staging deployment
   enforces limits per instance; Vercel cold starts (mitigated by preflight
   warm-up); the harness runs from one machine, so its own network is part of
   the measured latency.
7. **Results — Phase 1 pre-launch run** — the table the operator fills in,
   pre-populated with `Not run` / `Blocked` rows and columns
   `| Target | Threshold | Measured (p95) | Status | Date / commit |`. State
   that #83 reads this table and that a `Not run` or `Blocked` row means the
   pass is not complete.
8. **Blocked items** — OPEN QUESTION 1, spelled out with the file references.

## 7. Verification (coder must run before finishing)

- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test`.
- `bun run test:load` with no env vars set — must print the "not configured"
  skip and exit 0 (do **not** attempt a real staging run; the credentials are
  not available in this environment).
- Confirm `bun run test` does not pick up anything under `tests/load/`.
