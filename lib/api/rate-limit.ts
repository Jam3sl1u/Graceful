// NOTE: This module must NOT import "server-only". Unlike the rest of
// lib/api/**, it is imported directly by middleware.ts, which Next bundles
// for the Edge runtime. The repo has no precedent for pulling a
// "server-only"-tagged module into that bundle, so this file (and its own
// imports) is kept free of that marker. It does import `ErrorCode` from
// lib/api/errors, which is itself "server-only" tagged but is a plain string
// enum in practice — see the build verification note in .pipeline/changes.md
// for how this was confirmed safe with `bun run build`.
import { NextRequest, NextResponse } from "next/server";
import { ErrorCode } from "@/lib/api/errors";
import type { ApiError } from "@/types/api";

export type RateLimitTier = "webhook" | "sms" | "auth" | "write" | "read";

export type RateLimitPolicy = { limit: number; windowMs: number };

export type RateLimitDecision = {
  tier: RateLimitTier;
  allowed: boolean;
  limit: number;
  remaining: number; // 0 once the limit is hit
  retryAfterSeconds: number; // integer >= 1 when denied, 0 when allowed
  resetAtMs: number; // epoch ms at which the current window ends
};

// Tier -> policy table. Exported so tests assert the ordering invariant
// (sms < auth < write < read) instead of hardcoding numbers twice.
// These are first-pass numbers meant to be tuned by a human later; limits
// are in-memory/per-instance, not a global/distributed count (see
// .pipeline/spec.md OPEN QUESTIONS for the rationale).
export const RATE_LIMIT_POLICIES: Record<RateLimitTier, RateLimitPolicy> = {
  webhook: { limit: 600, windowMs: 60_000 },
  read: { limit: 240, windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  auth: { limit: 10, windowMs: 60_000 },
  sms: { limit: 5, windowMs: 60_000 },
};

const RESPOND_TOKEN_RE = /^\/api\/invitations\/respond\/[^/]+$/;
const INVITATION_ID_ACCEPT_RE = /^\/api\/invitations\/[^/]+\/accept$/;
const INVITATION_ID_DENY_RE = /^\/api\/invitations\/[^/]+\/deny$/;
const SETLIST_PUBLISH_RE = /^\/api\/setlists\/[^/]+\/publish$/;

// Pure path/method -> tier classification. Returns null when the request is
// exempt from rate limiting entirely.
export function resolveTier(pathname: string, method: string): RateLimitTier | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const verb = method.toUpperCase();

  if (!path.startsWith("/api/") && path !== "/api") {
    return null;
  }

  if (path === "/api/health") {
    return null;
  }

  if (path.startsWith("/api/webhooks/")) {
    return "webhook";
  }

  if (
    (verb === "POST" && path === "/api/invitations") ||
    (verb === "POST" && INVITATION_ID_DENY_RE.test(path)) ||
    (verb === "POST" && SETLIST_PUBLISH_RE.test(path)) ||
    path === "/api/cron/invitation-reminders"
  ) {
    return "sms";
  }

  if (
    (verb === "POST" && path === "/api/church-group/join") ||
    (verb === "GET" && RESPOND_TOKEN_RE.test(path)) ||
    (verb === "POST" && INVITATION_ID_ACCEPT_RE.test(path))
  ) {
    return "auth";
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(verb)) {
    return "write";
  }

  return "read";
}

// Stable per-caller bucket identity.
export function getRequestIdentifier(req: NextRequest, clerkUserId: string | null): string {
  if (clerkUserId && clerkUserId.length > 0) {
    return `user:${clerkUserId}`;
  }

  const forwardedFor = req.headers.get("x-forwarded-for");
  const firstHop = forwardedFor?.split(",")[0]?.trim();
  if (firstHop) {
    return `ip:${firstHop}`;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return `ip:${realIp}`;
  }

  // Missing/blank x-forwarded-for and x-real-ip: fall back to a shared
  // "unknown" bucket. Accepted trade-off — these callers share a budget
  // rather than each getting their own.
  return "ip:unknown";
}

const store = new Map<string, { count: number; windowStartMs: number }>();
const STORE_PRUNE_THRESHOLD = 10_000;
const MAX_CONFIGURED_WINDOW_MS = Math.max(
  ...Object.values(RATE_LIMIT_POLICIES).map((p) => p.windowMs),
);

// Fixed-window counter against the module-level store. `now` defaults to
// Date.now() and is injectable so tests never need fake timers.
export function checkRateLimit(
  key: string,
  policy: RateLimitPolicy,
  now: number = Date.now(),
): Omit<RateLimitDecision, "tier"> {
  let entry = store.get(key);
  if (!entry || now - entry.windowStartMs >= policy.windowMs) {
    entry = { count: 1, windowStartMs: now };
  } else {
    entry.count += 1;
  }
  store.set(key, entry);

  const resetAtMs = entry.windowStartMs + policy.windowMs;
  const allowed = entry.count <= policy.limit;
  const remaining = Math.max(0, policy.limit - entry.count);
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - now) / 1000));

  pruneStoreIfNeeded(now);

  return { allowed, limit: policy.limit, remaining, retryAfterSeconds, resetAtMs };
}

function pruneStoreIfNeeded(now: number): void {
  if (store.size <= STORE_PRUNE_THRESHOLD) {
    return;
  }

  for (const [key, entry] of store) {
    if (entry.windowStartMs + MAX_CONFIGURED_WINDOW_MS <= now) {
      store.delete(key);
    }
  }

  if (store.size > STORE_PRUNE_THRESHOLD) {
    store.clear();
  }
}

// Test-only: clears the module-level store.
export function resetRateLimitStore(): void {
  store.clear();
}

// Full request-level entry point used by middleware. Returns null when the
// request is exempt. Consumes one unit of budget when it does not return null.
export function checkRequestRateLimit(
  req: NextRequest,
  clerkUserId: string | null,
  now?: number,
): RateLimitDecision | null {
  const tier = resolveTier(req.nextUrl.pathname, req.method);
  if (tier === null) {
    return null;
  }

  const policy = RATE_LIMIT_POLICIES[tier];
  const key = `${tier}:${getRequestIdentifier(req, clerkUserId)}`;
  const decision = checkRateLimit(key, policy, now);

  return { tier, ...decision };
}

// Builds the 429. Only ever called with a denied decision.
export function rateLimitResponse(decision: RateLimitDecision): NextResponse {
  return NextResponse.json<ApiError>(
    { error: "Rate limit exceeded", code: ErrorCode.RATE_LIMITED },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}
