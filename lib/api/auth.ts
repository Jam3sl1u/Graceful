import "server-only";
import type { NextRequest } from "next/server";
import type { UserRole } from "@/types/domain";

export type AuthContext = {
  userId: string;
  churchGroupId: string;
  role: UserRole;
};

// TODO(Sprint 0 #6): resolve the Clerk JWT on `req`, look up the caller's
// church_group_id + role, and return an AuthContext. Every route handler
// should call this before touching business logic.
export async function requireAuth(_req: NextRequest): Promise<AuthContext> {
  throw new Error("requireAuth not implemented — see Sprint 0 #6");
}

// TODO(Sprint 0 #6): throw ApiException(FORBIDDEN) if ctx.role is not in roles.
export function requireRole(_ctx: AuthContext, _roles: UserRole[]): void {
  throw new Error("requireRole not implemented — see Sprint 0 #6");
}
