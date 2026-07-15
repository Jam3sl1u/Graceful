import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { decryptToken } from "@/lib/google-calendar/token-crypto";
import { revokeToken } from "@/lib/google-calendar/oauth";

// DELETE /api/google-calendar/disconnect — best-effort revoke at Google,
// then delete the stored row. Idempotent when there is nothing to
// disconnect; a failed revoke never blocks deletion (graceful degradation,
// PRD §25.5).
export async function disconnect(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error: selectError } = await supabase
      .from("google_calendar_tokens")
      .select("refresh_token_encrypted, access_token_encrypted")
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (selectError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    if (!data) {
      return ok({ disconnected: true });
    }

    // Best-effort revoke; revokeToken never throws, and a failed revoke
    // must not block deleting the row.
    try {
      const refreshToken = decryptToken(data.refresh_token_encrypted);
      await revokeToken(refreshToken);
    } catch {
      // Decryption or revoke failure — still proceed to delete the row.
    }

    const { error: deleteError } = await supabase
      .from("google_calendar_tokens")
      .delete()
      .eq("user_id", ctx.userId);

    if (deleteError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ disconnected: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
