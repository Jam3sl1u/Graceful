/**
 * JWT minting for RLS integration tests.
 *
 * Supabase validates JWTs with its own JWT secret (local dev) or via Clerk JWKS
 * (production). In tests we target the local Supabase instance and sign directly
 * with SUPABASE_JWT_SECRET, matching the format Supabase expects for
 * `authenticated` role tokens.
 *
 * The `sub` claim equals the user's `clerk_id` in the users table — this is how
 * the helper functions resolve identity when JWT custom claims are absent.
 */

import jwt from "jsonwebtoken";

/** Roles that the application recognises at the app layer. */
export type AppRole = "admin" | "set_leader" | "member" | "guest";

export interface TestClaims {
  /** Maps to users.clerk_id — used by auth_user_id() / auth_church_group_id() DB fallback. */
  clerkId: string;
  /**
   * Optional: set to skip the DB lookup round-trip in auth_church_group_id().
   * Omit to exercise the sub→DB fallback path (default for most tests).
   */
  churchGroupId?: string;
  /**
   * Optional app-level role claim. When omitted the helpers fall back to the DB
   * role column. NOTE: Supabase's own `role` claim is always 'authenticated';
   * passing an app role here tests the JWT-claim fast path in auth_user_role().
   */
  appRole?: AppRole;
  /** Seconds from now until exp. Default 3600. Negative -> already expired. */
  expiresInSeconds?: number;
  /** Sign with this secret instead of SUPABASE_JWT_SECRET (forged-signature tests). */
  signingSecret?: string;
}

/** Signs a short-lived JWT that Supabase local dev will accept as `authenticated`. */
export function mintJwt(claims: TestClaims): string {
  const secret = claims.signingSecret ?? process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET must be set to mint test JWTs");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresInSeconds = claims.expiresInSeconds ?? 3600;

  const payload: Record<string, unknown> = {
    sub: claims.clerkId,
    role: "authenticated", // Supabase built-in role — NOT the app role
    aud: "authenticated",
    iss: "supabase-test",
    iat: nowSeconds,
    exp: nowSeconds + expiresInSeconds,
  };

  // Negative expiresInSeconds means "already expired" — also back-date iat so
  // the token is not "issued in the future" relative to its own exp.
  if (expiresInSeconds < 0) {
    payload.iat = nowSeconds + expiresInSeconds;
  }

  if (claims.churchGroupId !== undefined) {
    payload.church_group_id = claims.churchGroupId;
  }

  // App role injected under a distinct key when testing JWT-claim fast path.
  // The auth_user_role() helper checks jwt ->> 'role'; because the built-in
  // 'authenticated' value fails the enum guard CASE, the helper always falls
  // back to DB. To test the JWT claim path, add the app role under 'role' after
  // the built-in claim — Supabase merges custom claims so both coexist.
  if (claims.appRole !== undefined) {
    // Override the built-in 'authenticated' so auth_user_role() picks it up.
    payload.role = claims.appRole;
  }

  return jwt.sign(payload, secret, { algorithm: "HS256" });
}
