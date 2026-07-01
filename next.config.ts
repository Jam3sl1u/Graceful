import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // song2score/ has its own node_modules — without this Next infers it as an
  // additional workspace root and emits a lockfile warning.
  outputFileTracingRoot: __dirname,
  eslint: {
    dirs: ["app", "components", "lib", "schemas", "types", "tests"],
  },
};

export default nextConfig;
