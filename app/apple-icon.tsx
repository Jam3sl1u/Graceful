import { ImageResponse } from "next/og";

// Next.js apple-icon file convention: produces the apple-touch-icon iOS uses
// when a page is added to the home screen. iOS ignores SVG here, so this
// renders the same "G" wordmark as a PNG via next/og (bundled with Next 15).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#4f46e5",
          color: "#ffffff",
          fontSize: 108,
        }}
      >
        G
      </div>
    ),
    { ...size },
  );
}
