import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Graceful",
  description: "Scheduling, setlist, and music coordination for worship teams.",
  applicationName: "Graceful",
  appleWebApp: { capable: true, title: "Graceful", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    // Explicit metadata.icons suppresses Next's automatic file-convention
    // merge of app/apple-icon.tsx, so it must be linked here manually.
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
  },
  // appleWebApp.capable only emits name="mobile-web-app-capable" in this
  // Next version; iOS Safari also needs the apple-prefixed tag.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// middleware.ts generates a fresh CSP nonce per request and signs Next's own
// inline bootstrap scripts with it — but Next only does that signing at
// render time. Static prerendering (the default whenever a route has
// nothing else forcing dynamic rendering) bakes HTML at build time with no
// nonce, so the browser's CSP blocks those scripts and the app never
// hydrates. Forcing dynamic rendering here, at the root, guarantees every
// route under this layout always renders per-request and gets a valid
// nonce; a child segment cannot opt back into static rendering once a
// parent forces dynamic.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
