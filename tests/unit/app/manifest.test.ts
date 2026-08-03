// Tests for app/manifest.ts (#75): the plain function is imported and its
// fields asserted directly, no Next request context required.

import manifest from "@/app/manifest";

describe("manifest", () => {
  const result = manifest();

  it("has the expected identity fields", () => {
    expect(result.name).toBe("Graceful");
    expect(result.short_name).toBe("Graceful");
    expect(result.description).toBe(
      "Scheduling, setlist, and music coordination for worship teams.",
    );
    expect(result.id).toBe("/");
  });

  it("keeps start_url inside scope so Chrome installability isn't silently broken", () => {
    expect(result.start_url).toBe("/dashboard");
    expect(result.scope).toBe("/");
  });

  it("has the expected display/theme fields", () => {
    expect(result.display).toBe("standalone");
    expect(result.background_color).toBe("#ffffff");
    expect(result.theme_color).toBe("#4f46e5");
  });

  it("has both icons, including an any-purpose SVG Chrome accepts for installability", () => {
    expect(result.icons).toEqual([
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      {
        src: "/icons/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ]);
  });
});
