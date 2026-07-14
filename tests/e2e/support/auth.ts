/**
 * Browser session-minting for the staging E2E suite (issue #52, OQ1).
 *
 * Resolution: use `@clerk/testing`'s Playwright helper against the seeded
 * staging Clerk test-mode users (tests/e2e/support/env.ts:
 * E2E_ADMIN_EMAIL / E2E_MEMBER_EMAIL). `clerk.signIn({ page, emailAddress })`
 * looks the user up via Clerk's Backend API and signs them in with a
 * short-lived sign-in ticket — no password needs to be provisioned or
 * stored. `clerkSetup()` (called once in tests/e2e/support/global-setup.ts)
 * fetches the testing token that lets this bypass Clerk's bot-detection
 * CAPTCHA in the test-mode instance.
 */

import type { Page } from "@playwright/test";
import { clerk } from "@clerk/testing/playwright";
import { requireEnv } from "./env";

export type TestRole = "admin" | "member";

// The page must already have navigated to a non-protected route that loads
// Clerk (e.g. "/") before calling this — @clerk/testing's own contract.
export async function signInAs(page: Page, role: TestRole): Promise<void> {
  const emailVar = role === "admin" ? "E2E_ADMIN_EMAIL" : "E2E_MEMBER_EMAIL";
  await clerk.signIn({ page, emailAddress: requireEnv(emailVar) });
}
