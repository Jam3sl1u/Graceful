import { NextRequest } from "next/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";

// Example admin-only route — demonstrates the requireAuth + requireRole pattern
// every Sprint 1–4 endpoint will copy. Exists primarily for #15 unit tests.
export async function GET(req: NextRequest, lookup?: UserLookup) {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);
    return ok({ ok: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
