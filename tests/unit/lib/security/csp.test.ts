import {
  buildContentSecurityPolicy,
  clerkFrontendApiOrigin,
  generateNonce,
} from "@/lib/security/csp";

describe("clerkFrontendApiOrigin", () => {
  it("derives the origin from a valid pk_test_ key", () => {
    // Encodes "clean-mayfly-62.clerk.accounts.dev$"
    const key = "pk_test_Y2xlYW4tbWF5Zmx5LTYyLmNsZXJrLmFjY291bnRzLmRldiQ=";
    expect(clerkFrontendApiOrigin(key)).toBe("https://clean-mayfly-62.clerk.accounts.dev");
  });

  it("derives the origin from a valid pk_live_ key", () => {
    // Encodes "app.clerk.example.com$"
    const key = "pk_live_" + Buffer.from("app.clerk.example.com$").toString("base64");
    expect(clerkFrontendApiOrigin(key)).toBe("https://app.clerk.example.com");
  });

  it("returns null for undefined", () => {
    expect(clerkFrontendApiOrigin(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(clerkFrontendApiOrigin("")).toBeNull();
  });

  it("returns null for a non-pk_ string", () => {
    expect(clerkFrontendApiOrigin("not-a-clerk-key")).toBeNull();
  });

  it("returns null when the base64 payload is garbage", () => {
    expect(clerkFrontendApiOrigin("pk_test_!!!not-base64!!!")).toBeNull();
  });

  it("returns null when the decoded host fails validation", () => {
    const key = "pk_test_" + Buffer.from("not a valid host$").toString("base64");
    expect(clerkFrontendApiOrigin(key)).toBeNull();
  });
});

describe("generateNonce", () => {
  it("produces two different nonces across calls", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });

  it("produces a valid base64 string decoding to 16 bytes", () => {
    const nonce = generateNonce();
    const decoded = Buffer.from(nonce, "base64");
    expect(decoded).toHaveLength(16);
    // Round-trips cleanly through base64 (no stray characters).
    expect(decoded.toString("base64")).toBe(nonce);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("isDev: false — contains the required directives and omits dev-only ones", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "abc123",
      clerkOrigin: "https://clerk.example.com",
      isDev: false,
    });

    expect(csp).toContain("'nonce-abc123'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("ws:");

    // No 'unsafe-inline' inside script-src specifically (style-src legitimately has it).
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // Single line, no double spaces.
    expect(csp).not.toContain("\n");
    expect(csp).not.toContain("  ");
  });

  it("isDev: true — adds 'unsafe-eval' and ws:, drops upgrade-insecure-requests", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "abc123",
      clerkOrigin: "https://clerk.example.com",
      isDev: true,
    });

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("clerkOrigin: null — well-formed output with no undefined/empty token", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "abc123",
      clerkOrigin: null,
      isDev: false,
    });

    expect(csp).not.toContain("undefined");
    expect(csp).not.toContain("null");
    expect(csp).not.toContain("  ");
    expect(csp).not.toContain("\n");

    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe("script-src 'self' 'nonce-abc123' https://challenges.cloudflare.com");

    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe("connect-src 'self' https://clerk-telemetry.com");
  });

  it("emits directives in the specified order and with no trailing semicolon", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "n",
      clerkOrigin: null,
      isDev: false,
    });

    const directiveNames = csp.split("; ").map((d) => d.split(" ")[0]);
    expect(directiveNames).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "worker-src",
      "frame-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
      "upgrade-insecure-requests",
    ]);
    expect(csp.endsWith(";")).toBe(false);
  });
});
