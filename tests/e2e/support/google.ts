/**
 * Google-side helpers for calendar-sync.spec.ts (issue #66, AC #4).
 *
 * Must NOT import from lib/ or app/: those modules start with
 * `import "server-only"`, which throws when imported by the plain-Node
 * Playwright runner (unlike Jest, which maps "server-only" to a mock — see
 * jest.config.js moduleNameMapper). toGoogleEventId and encryptE2EToken
 * below are therefore deliberate duplicates of their lib/ counterparts; keep
 * them in sync by hand (see the comment on each) — a Jest unit test
 * (tests/unit/e2e-support/google.test.ts, Testing stage) verifies they
 * agree.
 */

import { createCipheriv, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkEnv, requireEnv } from "./env";

// Extra env vars for the Google Calendar E2E spec, checked via
// checkEnv([...]) — deliberately NOT added to REQUIRED_VARS in ./env.ts,
// which would silently disable the entire existing E2E suite.
export const GOOGLE_SYNC_VARS = [
  "E2E_TOKEN_ENCRYPTION_KEY",
  "E2E_GOOGLE_CLIENT_ID",
  "E2E_GOOGLE_CLIENT_SECRET",
  "E2E_GOOGLE_REFRESH_TOKEN",
] as const;

export const googleSyncEnabled: boolean = checkEnv(GOOGLE_SYNC_VARS);

export function e2eCalendarId(): string {
  return process.env.E2E_GOOGLE_CALENDAR_ID || "primary";
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

// AES-256-GCM, output "iv:authTag:ciphertext" (all base64), 12-byte IV, key
// = base64-decoded E2E_TOKEN_ENCRYPTION_KEY (must be exactly 32 bytes).
// Byte-for-byte compatible with lib/google-calendar/token-crypto.ts's
// encryptToken — source of truth for the algorithm/format; keep in sync.
export function encryptE2EToken(plaintext: string): string {
  const raw = requireEnv("E2E_TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("E2E_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

// "gr" + uuid without dashes, lowercased. Mirrors
// lib/google-calendar/sync.ts's toGoogleEventId — source of truth; keep in
// sync.
export function toGoogleEventId(eventUuid: string): string {
  return `gr${eventUuid.replace(/-/g, "").toLowerCase()}`;
}

// Seeds/updates the member's google_calendar_tokens row so the app treats
// them as "Google Calendar connected". token_expiry is set in the PAST so
// the app's resolveAccessToken (lib/google-calendar/sync.ts) always takes
// the refresh path with the real refresh token — the access-token column is
// never decrypted on that path, so its ciphertext content doesn't matter
// beyond being well-formed.
export async function seedGoogleCalendarToken(
  svc: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await svc.from("google_calendar_tokens").upsert(
    {
      user_id: userId,
      access_token_encrypted: encryptE2EToken("e2e-placeholder-access-token"),
      refresh_token_encrypted: encryptE2EToken(requireEnv("E2E_GOOGLE_REFRESH_TOKEN")),
      token_expiry: new Date(Date.now() - 60_000).toISOString(),
      calendar_id: e2eCalendarId(),
      scope: "https://www.googleapis.com/auth/calendar.events",
      is_valid: true,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`seedGoogleCalendarToken failed: ${error.message}`);
}

// Test-side refresh-token exchange so the test can read the calendar itself
// (independently of the app's own token handling under test).
export async function getGoogleAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("E2E_GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("E2E_GOOGLE_CLIENT_SECRET"),
      refresh_token: requireEnv("E2E_GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`getGoogleAccessToken: refresh exchange failed with status ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("getGoogleAccessToken: refresh exchange response missing access_token");
  }
  return body.access_token;
}

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export async function getGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
      googleEventId,
    )}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Cleanup helper — treats 404/410 (already gone) as success and never
// throws, so a failure here never masks the actual test result in a
// `finally` block.
export async function deleteGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
        googleEventId,
      )}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error(
        `deleteGoogleCalendarEvent: DELETE failed with status ${res.status} for ${googleEventId}`,
      );
    }
  } catch (err) {
    console.error("deleteGoogleCalendarEvent: request failed", err);
  }
}
