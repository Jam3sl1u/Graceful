import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // song2score/ has its own node_modules — without this Next infers it as an
  // additional workspace root and emits a lockfile warning.
  outputFileTracingRoot: __dirname,
  eslint: {
    dirs: ["app", "components", "lib", "schemas", "types", "tests"],
  },
  // HTTPS enforcement (issue #78, PRD §25.7): Vercel performs the actual
  // HTTP->HTTPS redirect (platform behavior, not repo config), and this HSTS
  // header tells browsers to go straight to HTTPS on every subsequent
  // request, including app/api/** and webhook routes. CSP is intentionally
  // NOT set here — it must be per-request (nonce-based), which only
  // middleware.ts can do.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
