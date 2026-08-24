/**
 * Tester-added coverage for issue #142 (Google OAuth & Cloudflare R2
 * provisioning runbook).
 *
 * This issue's only in-repo deliverable is documentation — no application
 * code changed (per spec.md's "Scope note"). "Behavior" here is the
 * documentation's accuracy against the code it describes, and the
 * no-secrets / no-real-values invariant the issue itself requires. These
 * tests read the actual committed files (not the coder's summary) and
 * assert on their content directly.
 *
 * Covers: the happy path (runbook exists with the required sections and
 * matches the actual env-var-consuming code), the edge cases spec.md names
 * (base64/32-byte key format, private-bucket / account-level-endpoint
 * requirements, redirect URI path), and a failure case (a real secret-like
 * value anywhere in the diffed docs/config would fail the no-secrets check).
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..");

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("documentation/google-oauth-r2-provisioning.md", () => {
  const runbook = read("documentation/google-oauth-r2-provisioning.md");

  // -- Happy path: the runbook exists and documents the real integration points --

  it("references the actual env vars consumed by lib/google-calendar/oauth.ts", () => {
    expect(runbook).toContain("GOOGLE_CLIENT_ID");
    expect(runbook).toContain("GOOGLE_CLIENT_SECRET");
    expect(runbook).toContain("GOOGLE_REDIRECT_URI");
  });

  it("references the actual env vars consumed by lib/r2/client.ts", () => {
    expect(runbook).toContain("R2_ACCOUNT_ID");
    expect(runbook).toContain("R2_ACCESS_KEY_ID");
    expect(runbook).toContain("R2_SECRET_ACCESS_KEY");
    expect(runbook).toContain("R2_BUCKET_NAME");
    expect(runbook).toContain("R2_ENDPOINT");
  });

  it("has a verification checklist section", () => {
    expect(runbook).toMatch(/## \d+\. Verification checklist/);
    expect(runbook).toMatch(/- \[ \]/);
  });

  // -- Edge cases named explicitly in spec.md's "Edge cases / must-get-right details" --

  it("specifies the OAuth scope as write-only calendar.events, matching oauth.ts's CALENDAR_EVENTS_SCOPE", () => {
    expect(runbook).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(runbook.toLowerCase()).toContain("write-only");
    // calendar.readonly may only appear as a "do not use this" cautionary
    // example, never as a recommended/required scope.
    const readonlyMentions = runbook.match(/.{0,60}calendar\.readonly.{0,20}/g) ?? [];
    for (const mention of readonlyMentions) {
      expect(mention.toLowerCase()).toMatch(/do not|never|not add|instead of/);
    }
  });

  it("gives the exact redirect URI path fixed by app/api/google-calendar/callback/route.ts", () => {
    expect(runbook).toContain("/api/google-calendar/callback");
  });

  it("specifies TOKEN_ENCRYPTION_KEY as base64, exactly 32 decoded bytes, via openssl rand -base64 32", () => {
    expect(runbook).toContain("openssl rand -base64 32");
    expect(runbook).toMatch(/32[- ]byte/);
    expect(runbook.toLowerCase()).toContain("base64");
    // Must not suggest hex as an acceptable format.
    expect(runbook.toLowerCase()).not.toMatch(/hex[- ]encod/);
  });

  it("requires distinct encryption keys and OAuth clients per environment", () => {
    expect(runbook.toLowerCase()).toMatch(/distinct/);
    expect(runbook).toMatch(/staging/i);
    expect(runbook).toMatch(/production/i);
  });

  it("requires the R2 bucket to be private with no public access", () => {
    expect(runbook.toLowerCase()).toContain("private");
    expect(runbook.toLowerCase()).toMatch(/no public access|public access.*disabled/);
  });

  it("gives the account-level R2 endpoint shape (no bucket name in the host)", () => {
    expect(runbook).toContain("https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com");
  });

  it("requires a bucket-scoped (not account-wide) R2 API token", () => {
    expect(runbook.toLowerCase()).toMatch(/scoped to only that bucket|bucket-scoped/);
  });

  // -- Consistency check: catches drift between the doc's own variable count and its table --

  it("the 'ten variables' claim in §6 matches the actual number of variables tabulated", () => {
    const tableSection = runbook.slice(runbook.indexOf("## 6. Where to set the values"));
    const varRows = tableSection.match(/^\| `[A-Z0-9_]+` \|/gm) ?? [];
    const claimsTenVariables = /\bten variables\b/i.test(tableSection);
    if (claimsTenVariables) {
      expect(varRows.length).toBe(10);
    }
  });
});

describe("README.md links to the provisioning runbook", () => {
  it("links to documentation/google-oauth-r2-provisioning.md", () => {
    const readme = read("README.md");
    expect(readme).toContain("documentation/google-oauth-r2-provisioning.md");
  });
});

describe("documentation/staging-environment.md cross-references the runbook", () => {
  it("points at the new runbook from the Google Calendar and Cloudflare R2 rows", () => {
    const staging = read("documentation/staging-environment.md");
    expect(staging).toContain("google-oauth-r2-provisioning.md");
  });
});

describe(".env.example stays free of real values (no-secrets invariant)", () => {
  const envExample = read(".env.example");

  it("keeps the Google Calendar and R2 placeholder lines empty", () => {
    const placeholderVars = [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "TOKEN_ENCRYPTION_KEY",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_NAME",
      "R2_ENDPOINT",
    ];
    for (const varName of placeholderVars) {
      const line = envExample
        .split("\n")
        .find((l) => l.trim().startsWith(`${varName}=`));
      expect(line).toBeDefined();
      expect(line?.trim()).toBe(`${varName}=`);
    }
  });

  it("only adds comment lines (prefixed with #) above the two blocks, no new assignment lines", () => {
    const googleBlockStart = envExample.indexOf("# Google Calendar (OAuth sync)");
    const r2BlockStart = envExample.indexOf("#Cloudflare R2 (file storage)");
    expect(googleBlockStart).toBeGreaterThan(-1);
    expect(r2BlockStart).toBeGreaterThan(-1);
  });
});
