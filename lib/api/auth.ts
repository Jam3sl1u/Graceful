import "server-only";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import type { UserRole } from "@/types/domain";

export type AuthContext = {
  userId: string; // internal users.id (uuid), NOT the Clerk id
  churchGroupId: string;
  role: UserRole;
};

// Lookup seam — real impl added when #16 (users table) lands. Injected in tests.
export type UserLookup = (clerkId: string) => Promise<AuthContext | null>;

// TODO(#16): SELECT id, church_group_id, role FROM users WHERE clerk_id = $1
// Maps clerk_id -> AuthContext per PRD §20.3 `users` table.
async function lookupUserByClerkId(_clerkId: string): Promise<AuthContext | null> {
  throw new Error(
    "user lookup not implemented — blocked on #16 (users table) / #7-14 (supabase client)",
  );
}

// requireAuth: verify the Clerk JWT, then resolve the DB-backed AuthContext.
// `lookup` defaults to the real (currently pending) DB lookup; tests pass a fake.
export async function requireAuth(
  _req: NextRequest,
  lookup: UserLookup = lookupUserByClerkId,
): Promise<AuthContext> {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    throw new ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
  }

  const ctx = await lookup(clerkId);
  if (!ctx) {
    throw new ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
  }

  return ctx;
}

export function requireRole(ctx: AuthContext, roles: UserRole[]): void {
  if (roles.includes(ctx.role)) {
    return;
  }
  throw new ApiException("Insufficient permissions", ErrorCode.FORBIDDEN, 403);
}
