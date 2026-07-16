import "server-only";

// Write-only scope: this app never reads a member's Google calendar, only
// creates/updates/deletes events it created itself (PRD §25.5).
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

// Builds the Google consent URL. `state` is the CSRF token verified by the
// callback route against the `gcal_oauth_state` cookie.
export function getAuthUrl(state: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error("Missing required env vars: GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI must be set");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CALENDAR_EVENTS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string; // required — see exchangeCode edge case below
  expiryDate: string; // ISO timestamptz for token_expiry
  scope: string;
};

// Exchanges an OAuth authorization code for tokens. Throws on any HTTP
// failure or when Google omits a refresh_token (e.g. a repeat consent
// without `prompt=consent`) — the caller must not persist a partial row.
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set",
    );
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error("Failed to exchange Google OAuth code for tokens");
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  // Google omits refresh_token on a repeat consent without `prompt=consent`;
  // the row's refresh_token_encrypted column is NOT NULL, so a missing
  // refresh_token must fail the exchange rather than write a partial row.
  if (!json.refresh_token) {
    throw new Error("Google did not return a refresh_token");
  }

  return {
    accessToken: json.access_token ?? "",
    refreshToken: json.refresh_token,
    expiryDate: new Date(Date.now() + (json.expires_in ?? 0) * 1000).toISOString(),
    scope: json.scope ?? "",
  };
}

// Best-effort revoke, used on disconnect. Never throws — a failed revoke
// must not block deleting the stored row (graceful degradation, PRD §25.5).
export async function revokeToken(token: string): Promise<void> {
  try {
    const res = await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!res.ok) {
      console.warn("Google token revoke returned a non-2xx response");
    }
  } catch {
    console.warn("Google token revoke failed");
  }
}
