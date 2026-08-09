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
 *  when the caller's AuthContext belongs to DEFAULT_CHURCH_GROUP_ID. */
export const VICTIM_CHURCH_GROUP_ID = "group-victim-2";
export const VICTIM_USER_ID = "user-victim-2";

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
 *  (nextUrl.searchParams / nextUrl.pathname), a JSON body, and headers. */
export function makeApiReq(opts?: {
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}): NextRequest {
  const searchParams = new URLSearchParams(opts?.query ?? {});
  return {
    nextUrl: { searchParams, pathname: "/api/test" },
    json: jest.fn().mockResolvedValue(opts?.body),
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
