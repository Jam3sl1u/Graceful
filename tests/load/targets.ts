/**
 * Static targets, load profile, endpoint registry, and rate-limit-policy
 * mirror for the load-test harness (issue #81, PRD §14.1). Pure data — no
 * network, no imports from app/**, lib/**, or any Next/Clerk/Supabase
 * module (see .pipeline/spec.md §2 constraints).
 */

export type PerfTarget = {
  id: "api" | "signedUrl" | "sms" | "email";
  label: string;
  thresholdMs: number; // p95
  criterion: string; // the AC sentence this comes from
};

export const PERF_TARGETS: Readonly<Record<PerfTarget["id"], PerfTarget>> = {
  api: {
    id: "api",
    label: "API response time",
    thresholdMs: 500,
    criterion: "API response time p95 < 500ms @ 100 concurrent users",
  },
  signedUrl: {
    id: "signedUrl",
    label: "Signed URL generation",
    thresholdMs: 200,
    criterion: "Signed URL generation p95 < 200ms",
  },
  sms: {
    id: "sms",
    label: "SMS delivery",
    thresholdMs: 30_000,
    criterion: "SMS delivery p95 < 30s @ 50 simultaneous sends",
  },
  email: {
    id: "email",
    label: "Email delivery",
    thresholdMs: 60_000,
    criterion: "Email delivery p95 < 60s @ 50 simultaneous sends",
  },
};

export const LOAD_PROFILE = {
  concurrentUsers: 100,
  durationSeconds: 60,
  rampUpSeconds: 10,
  requestTimeoutMs: 30_000,
  maxErrorRate: 0.01, // >1% non-429 error responses ⇒ run invalid
  // Pacing delay between each virtual user's iterations. Without this, 100
  // workers loop as fast as the network allows with zero think-time, which
  // self-floods the server (2M+ requests/60s observed against a local mock)
  // and produces a connection-drop error rate that fails the run before p95
  // is even meaningful. 500ms keeps concurrentUsers at the AC1-mandated 100
  // while capping steady-state throughput to a sane ceiling.
  thinkTimeMs: 500,
} as const;

export const NOTIFICATION_PROFILE = { simultaneousSends: 50 } as const;

export type Persona = "none" | "member" | "admin";

export type EndpointScenario = { name: string; method: "GET"; path: string; persona: Persona };

// Implemented GET routes with no required query params. Every one below was
// verified to exist and not be a `notImplemented` stub; `persona` mirrors
// each handler's own `requireRole(...)` call (admin used when unsure — an
// admin token satisfies every route). Do NOT add /api/church-group,
// /api/notifications, /api/notifications/unread-count, or any
// /api/webhooks/* route — they are `notImplemented` 501 stubs today.
export const API_ENDPOINTS: readonly EndpointScenario[] = [
  { name: "GET /api/health", method: "GET", path: "/api/health", persona: "none" },
  { name: "GET /api/profile", method: "GET", path: "/api/profile", persona: "member" },
  {
    name: "GET /api/church-group/members",
    method: "GET",
    path: "/api/church-group/members",
    persona: "member",
  },
  { name: "GET /api/songs", method: "GET", path: "/api/songs", persona: "member" },
  { name: "GET /api/service-weeks", method: "GET", path: "/api/service-weeks", persona: "member" },
  { name: "GET /api/events", method: "GET", path: "/api/events", persona: "member" },
  { name: "GET /api/availability", method: "GET", path: "/api/availability", persona: "member" },
  {
    name: "GET /api/notifications/preferences",
    method: "GET",
    path: "/api/notifications/preferences",
    persona: "member",
  },
  { name: "GET /api/conflicts", method: "GET", path: "/api/conflicts", persona: "admin" },
  {
    name: "GET /api/service-weeks/overview",
    method: "GET",
    path: "/api/service-weeks/overview",
    persona: "admin",
  },
  {
    name: "GET /api/church-group/audit-log",
    method: "GET",
    path: "/api/church-group/audit-log",
    persona: "admin",
  },
  { name: "GET /api/instruments", method: "GET", path: "/api/instruments", persona: "admin" },
];

// Mirrors RATE_LIMIT_POLICIES in lib/api/rate-limit.ts; kept in sync by
// tests/unit/load/targets.test.ts (tests/load/** cannot import lib/** — see
// .pipeline/spec.md §2 — so the unit test, which lives outside tests/load/**,
// is the sync check).
export const EXPECTED_RATE_LIMIT_POLICIES: Readonly<
  Record<
    "webhook" | "read" | "write" | "auth" | "invite" | "sms",
    { limit: number; windowMs: number }
  >
> = {
  webhook: { limit: 600, windowMs: 60_000 },
  read: { limit: 240, windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  auth: { limit: 50, windowMs: 60_000 },
  invite: { limit: 30, windowMs: 60_000 },
  sms: { limit: 5, windowMs: 60_000 },
};
