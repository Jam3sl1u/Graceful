import { NextRequest } from "next/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";

export async function adminOnlyExample(req: NextRequest, lookup?: UserLookup) {
  try {
    // #region agent log
    if (process.env.NODE_ENV === "test") fetch('http://127.0.0.1:7538/ingest/73d41e57-f389-4de1-b0c9-c98dcb4b4f16',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8ebabd'},body:JSON.stringify({sessionId:'8ebabd',runId:'pre-fix',hypothesisId:'H2',location:'app/api/_examples/admin-only/handler.ts:entry',message:'adminOnlyExample entry',data:{hasLookup:!!lookup},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);
    return ok({ ok: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

