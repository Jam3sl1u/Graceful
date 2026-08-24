import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getAuthUrl } from "@/lib/google-calendar/oauth";

const STATE_COOKIE = "gcal_oauth_state";

// POST /api/google-calendar/connect — starts the OAuth flow: sets a CSRF
// state cookie and returns the Google consent URL for the client to
// navigate to. Any authenticated member may connect their own calendar; no
// role gate.
export async function connect(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    await requireAuth(req, lookup);

    const state = randomBytes(32).toString("base64url");

    const cookieStore = await cookies();
    cookieStore.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });

    const authUrl = getAuthUrl(state);

    return ok({ authUrl });
  } catch (err) {
    console.error("[TEMP DEBUG] /api/google-calendar/connect threw:", err);
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
