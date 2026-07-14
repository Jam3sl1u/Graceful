/**
 * Playwright global setup (issue #52, OQ1/OQ4). Runs once before the whole
 * suite (see playwright.config.ts's `globalSetup`). Two jobs, both skipped
 * silently when the E2E secrets aren't configured (local runs, or CI without
 * staging provisioned) so tests/e2e/health.spec.ts is unaffected — every
 * test in the auth-dependent specs gates itself on `e2eAuthEnabled` and
 * skips individually instead:
 *
 *  1. `clerkSetup()` fetches a Clerk testing token so
 *     `@clerk/testing/playwright`'s sign-in helper (tests/e2e/support/auth.ts)
 *     can bypass Clerk's bot-detection CAPTCHA in the test-mode instance.
 *  2. Idempotently seed the stable admin/member/church fixture every
 *     authenticated test shares (tests/e2e/support/fixtures.ts explains why
 *     it's stable rather than per-test).
 */

import { clerkSetup } from "@clerk/testing/playwright";
import { e2eAuthEnabled } from "./env";
import { getE2EServiceClient } from "./db";
import { ensureChurchFixture } from "./fixtures";

export default async function globalSetup(): Promise<void> {
  if (!e2eAuthEnabled) return;

  await clerkSetup();

  const svc = getE2EServiceClient();
  await ensureChurchFixture(svc);
}
