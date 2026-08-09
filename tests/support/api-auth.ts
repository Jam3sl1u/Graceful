import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

// Shared, reusable auth-matrix harness (issue #32 T2). Centralizes the
// Clerk-auth + role-lookup mock boilerplate that used to be copy-pasted
// across the per-route test files (see e.g.
// tests/unit/app/api/service-weeks-route.test.ts and
// tests/unit/app/api/instruments-route.test.ts). Consuming test files must
// mock "@clerk/nextjs/server" so `auth` here resolves to that mock:
//
//   jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));

const mockAuth = auth as unknown as jest.Mock;

// Promoted to exports (issue #80) so registry assertions and the harness
// cannot drift apart — makeLookup still uses these as its defaults.
export const DEFAULT_USER_ID = "user-1";
export const DEFAULT_CHURCH_GROUP_ID = "group-1";

/** The "victim" tenant. Must never appear in any handler's DB interaction
 *  when the caller's AuthContext belongs to DEFAULT_CHURCH_GROUP_ID.
 *  UUID-shaped to match the R1/R2 resource-id convention used elsewhere —
 *  the shape isn't validated (these are injected under keys no real schema
 *  declares, see makeApiReq below), but it keeps the fixtures consistent. */
export const VICTIM_CHURCH_GROUP_ID = "99999999-9999-4999-8999-999999999991";
export const VICTIM_USER_ID = "99999999-9999-4999-8999-999999999992";

// Probe keys merged into every makeApiReq() request's query string and (when
// a body object is already present) body — see makeApiReq below. No schema
// in schemas/*.ts declares a churchGroupId/church_group_id/userId/user_id
// field that a client is meant to supply (tenant scope always comes from
// AuthContext), and none use `.strict()`, so these are silently stripped by
// every real handler. This is what makes the auth-bypass-matrix.test.ts case
// 4 "victim id never leaks" assertion a live check instead of a vacuous one:
// the two VICTIM_* values are now actually reachable in every request, so a
// handler that ever echoed a caller-supplied scope id into the DB layer
// would be caught.
const VICTIM_TENANT_PROBE: Record<string, string> = {
  churchGroupId: VICTIM_CHURCH_GROUP_ID,
  church_group_id: VICTIM_CHURCH_GROUP_ID,
  userId: VICTIM_USER_ID,
  user_id: VICTIM_USER_ID,
};

// Injectable lookup returning a fixed AuthContext for the given role.
// Mirrors the makeLookup() duplicated in the existing handler tests.
export function makeLookup(role: UserRole, overrides?: Partial<AuthContext>): UserLookup {
  const ctx: AuthContext = {
    userId: DEFAULT_USER_ID,
    churchGroupId: DEFAULT_CHURCH_GROUP_ID,
    role,
    ...overrides,
  };
  return async () => ctx;
}

/** Models an expired/absent Supabase template JWT: the Clerk session resolves
 *  but the DB-backed lookup yields no AuthContext -> requireAuth throws 401. */
export function makeNullLookup(): UserLookup {
  return async () => null;
}

/** NextRequest double covering the three things handlers read: query params
 *  (nextUrl.searchParams / nextUrl.pathname), a JSON body, and headers.
 *
 *  Every request's query string is merged with VICTIM_TENANT_PROBE (explicit
 *  `opts.query` keys win); the body is merged the same way, but only when
 *  `opts.body` is already a plain object — an omitted body stays `undefined`
 *  so `json()` resolving `undefined` (the malformed-body convention) is
 *  unaffected. See VICTIM_TENANT_PROBE above for why.
 *
 *  `excludeProbeKeys` opts a specific request out of specific probe keys.
 *  Needed for GET /api/availability's plain (non-admin-lookup) entry:
 *  getAvailabilityQuerySchema's `user_id` is a real, presence-sensitive
 *  field (its handler switches into the cross-user admin-lookup branch
 *  whenever `user_id` is present at all, regardless of value — see
 *  app/api/availability/handler.ts), so unconditionally injecting one would
 *  silently change which code path that entry exercises. */
export function makeApiReq(opts?: {
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  excludeProbeKeys?: string[];
}): NextRequest {
  const probe = opts?.excludeProbeKeys
    ? Object.fromEntries(
        Object.entries(VICTIM_TENANT_PROBE).filter(([k]) => !opts.excludeProbeKeys!.includes(k)),
      )
    : VICTIM_TENANT_PROBE;
  const searchParams = new URLSearchParams({ ...probe, ...opts?.query });
  const isPlainObject =
    typeof opts?.body === "object" && opts.body !== null && !Array.isArray(opts.body);
  const body = isPlainObject
    ? { ...probe, ...(opts!.body as Record<string, unknown>) }
    : opts?.body;
  return {
    nextUrl: { searchParams, pathname: "/api/test" },
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers(opts?.headers ?? {}),
    method: "GET",
  } as unknown as NextRequest;
}

// Configure the module-mocked auth() (from "@clerk/nextjs/server") as a
// signed-in Clerk user whose supabase JWT is `jwt` (default a non-empty
// string; pass null to simulate "session present but no JWT issued").
export function mockClerkAuthed(jwt: string | null = "supabase-jwt"): void {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

// Configure the module-mocked auth() as NO Clerk session.
export function mockClerkAnonymous(): void {
  mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
}

// Build a NextRequest whose .json() resolves `body` (pass nothing / undefined
// to simulate a malformed/empty body).
export function makeJsonReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}
