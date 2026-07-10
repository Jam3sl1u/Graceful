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

const DEFAULT_USER_ID = "user-1";
const DEFAULT_CHURCH_GROUP_ID = "group-1";

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
