// Content-Security-Policy helpers for issue #78 (PRD §25.7, cited as §15.7 in
// the issue). Pure, dependency-free, edge-safe: this module is imported by
// Edge middleware (middleware.ts), so it must not `import "server-only"` or
// depend on any Node-only API.
//
// `challenges.cloudflare.com` and `img.clerk.com` are Clerk's own documented
// CSP requirements (the bot-protection widget and the avatar CDN
// respectively), so they are treated as falling under "self and Clerk".
// `style-src 'unsafe-inline'` is required by Next.js/Clerk injected styles
// and is explicitly *not* prohibited by this issue's acceptance criteria,
// which prohibit inline **scripts** and `eval` — not inline styles.

/**
 * Derives a Clerk instance's frontend-API origin from its publishable key.
 * A Clerk publishable key is `pk_test_`/`pk_live_` followed by the base64
 * encoding of the instance's frontend-API host with a trailing `$`. We
 * derive the origin from the key rather than hardcoding a domain because the
 * production domain is not known yet.
 */
export function clerkFrontendApiOrigin(publishableKey: string | undefined): string | null {
  if (!publishableKey) return null;

  let encoded: string | null = null;
  if (publishableKey.startsWith("pk_test_")) {
    encoded = publishableKey.slice("pk_test_".length);
  } else if (publishableKey.startsWith("pk_live_")) {
    encoded = publishableKey.slice("pk_live_".length);
  }
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }

  const host = decoded.split("$")[0] ?? "";
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;

  return `https://${host}`;
}

/**
 * Generates a cryptographically random, base64-encoded nonce for a single
 * request's Content-Security-Policy header. Must be unique per call.
 */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Builds the single-line Content-Security-Policy header value for a request.
 */
export function buildContentSecurityPolicy(options: {
  nonce: string;
  clerkOrigin: string | null;
  isDev: boolean;
}): string {
  const { nonce, clerkOrigin, isDev } = options;

  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "https://challenges.cloudflare.com"];
  if (clerkOrigin) scriptSrc.push(clerkOrigin);
  if (isDev) scriptSrc.push("'unsafe-eval'");

  const connectSrc = ["'self'", "https://clerk-telemetry.com"];
  if (clerkOrigin) connectSrc.push(clerkOrigin);
  if (isDev) connectSrc.push("ws:");

  const directives: string[] = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(" ")}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https://img.clerk.com`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc.join(" ")}`,
    `worker-src 'self' blob:`,
    `frame-src 'self' https://challenges.cloudflare.com`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (!isDev) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
