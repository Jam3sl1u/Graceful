import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { exchangeCode } from "@/lib/google-calendar/oauth";
import { encryptToken } from "@/lib/google-calendar/token-crypto";
import { syncAllEventsForUser } from "@/lib/google-calendar/sync";
import { googleCalendarCallbackQuerySchema } from "@/schemas/google-calendar";

const STATE_COOKIE = "gcal_oauth_state";
const CONNECTED_PATH = "/profile?calendar=connected";
const ERROR_PATH = "/profile?calendar=error";

// GET /api/google-calendar/callback — the browser redirect target Google
// sends the member back to after consent. Always responds with an HTTP
// redirect (never JSON): /profile?calendar=connected on success,
// /profile?calendar=error on any failure. Clears the CSRF state cookie in
// every path.
export async function callback(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  const cookieStore = await cookies();

  function redirectError(): Response {
    cookieStore.delete(STATE_COOKIE);
    return NextResponse.redirect(new URL(ERROR_PATH, req.url));
  }

  function redirectConnected(): Response {
    cookieStore.delete(STATE_COOKIE);
    return NextResponse.redirect(new URL(CONNECTED_PATH, req.url));
  }

  try {
    const ctx = await requireAuth(req, lookup);

    // Object.fromEntries resolves a duplicate query param last-wins, vs. the
    // previous searchParams.get() calls here which were first-wins. Google's
    // OAuth redirect never sends duplicates for these params, so this is an
    // accepted, no-impact behavior delta from adopting schema validation.
    const parsedQuery = googleCalendarCallbackQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedQuery.success) {
      return redirectError();
    }
    const { error, code, state } = parsedQuery.data;

    // User denied consent (or Google reported some other error) — nothing
    // to store.
    if (error) {
      return redirectError();
    }

    if (!code || !state) {
      return redirectError();
    }

    // CSRF check: the state must match the value we set on /connect.
    const expectedState = cookieStore.get(STATE_COOKIE)?.value;
    if (!expectedState || expectedState !== state) {
      return redirectError();
    }

    const tokens = await exchangeCode(code);

    const accessTokenEncrypted = encryptToken(tokens.accessToken);
    const refreshTokenEncrypted = encryptToken(tokens.refreshToken);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return redirectError();
    }
    const supabase = getSupabaseClient(jwt);

    // The hand-written Insert type marks defaulted columns as required even
    // though the DB has defaults; cast narrowly here (mirrors the profile
    // handler's upsert cast). is_valid: true covers both a fresh connect and
    // a reconnect after a prior revoke (#62 — clears the invalid flag).
    const upsertPayload = {
      user_id: ctx.userId,
      access_token_encrypted: accessTokenEncrypted,
      refresh_token_encrypted: refreshTokenEncrypted,
      token_expiry: tokens.expiryDate,
      calendar_id: "primary",
      scope: tokens.scope,
      is_valid: true,
      updated_at: new Date().toISOString(),
    } as unknown as Database["public"]["Tables"]["google_calendar_tokens"]["Insert"];

    const { error: upsertError } = await supabase
      .from("google_calendar_tokens")
      .upsert(upsertPayload, { onConflict: "user_id" });

    if (upsertError) {
      return redirectError();
    }

    // Retroactive sync: push every event the member is already an attendee
    // of onto their (newly connected/reconnected) calendar. Best-effort — a
    // sync failure still reports "connected" (#62).
    try {
      await syncAllEventsForUser(supabase, ctx.userId);
    } catch {
      // never block the connected redirect on sync failure
    }

    return redirectConnected();
  } catch {
    return redirectError();
  }
}
