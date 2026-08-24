import type { MetadataRoute } from "next";

// Next.js manifest file convention: served at /manifest.webmanifest and
// auto-linked into <head> by Next. Do not also set metadata.manifest in
// app/layout.tsx — that would emit a duplicate <link rel="manifest">.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Graceful",
    short_name: "Graceful",
    description: "Scheduling, setlist, and music coordination for worship teams.",
    id: "/",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      // PNG fallbacks for installers that don't support SVG manifest icons.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
