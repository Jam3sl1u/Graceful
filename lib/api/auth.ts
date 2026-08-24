import "server-only";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import type { UserRole } from "@/types/domain";
import { getSupabaseClient } from "@/lib/supabase/client";

export type AuthContext = {
  userId: string; // internal users.id (uuid), NOT the Clerk id
  churchGroupId: string;
  role: UserRole;
};

// Lookup seam — injected in tests to avoid hitting Supabase.
export type UserLookup = (clerkId: string) => Promise<AuthContext | null>;

// Queries the users table via an RLS-scoped Supabase client.
// Returns null when the Clerk user has no matching row (not yet provisioned).
// Throws ApiException 500 on DB error; JWT missing → null (treated as 401 by caller).
// Full group-scoped RLS policies are in 20260704000001_rls_policies.sql (#22).
export async function lookupUserByClerkId(clerkId: string): Promise<AuthContext | null> {
  const { getToken } = await auth();
  const jwt = await getToken();
  if (!jwt) return null;

  const supabase = getSupabaseClient(jwt);
  const { data, error } = await supabase
    .from("users")
    .select("id, church_group_id, role")
    .eq("clerk_id", clerkId)
    .maybeSingle();

  if (error) throw new ApiException("Internal error", ErrorCode.INTERNAL, 500);
  if (!data) return null;

  return { userId: data.id, churchGroupId: data.church_group_id, role: data.role };
}

// requireAuth: verify the Clerk JWT, then resolve the DB-backed AuthContext.
// `lookup` defaults to the real DB lookup; tests pass a fake.
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
