import { NextRequest } from "next/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";

export async function adminOnlyExample(req: NextRequest, lookup?: UserLookup) {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);
    return ok({ ok: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

