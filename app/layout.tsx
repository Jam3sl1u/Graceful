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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
