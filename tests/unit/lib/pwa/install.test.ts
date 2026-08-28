// Tests for lib/pwa/install.ts (#75). Pure module — literal UA strings and
// plain stub objects, no browser required.

import {
  INSTALL_DISMISSED_KEY,
  isInstallPromptDismissed,
  isIosInstallCapable,
  isRunningStandalone,
  markInstallPromptDismissed,
} from "@/lib/pwa/install";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_13 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.0 Safari/605.1.15";
const DESKTOP_MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) CriOS/119.0.0.0 Mobile/15E148 Safari/604.1";
const IOS_FIREFOX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) FxiOS/119.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/119.0.0.0 Mobile Safari/537.36";

describe("isRunningStandalone", () => {
  it("is true when display-mode: standalone matches (Android/Chrome)", () => {
    expect(
      isRunningStandalone({ matchMedia: () => ({ matches: true }) }),
    ).toBe(true);
  });

  it("is true when navigator.standalone is true (iOS Safari)", () => {
    expect(
      isRunningStandalone({
        matchMedia: () => ({ matches: false }),
        navigator: { standalone: true },
      }),
    ).toBe(true);
  });

  it("is false otherwise", () => {
    expect(
      isRunningStandalone({ matchMedia: () => ({ matches: false }), navigator: {} }),
    ).toBe(false);
  });

  it("tolerates a missing matchMedia", () => {
    expect(isRunningStandalone({})).toBe(false);
  });
});

describe("isIosInstallCapable", () => {
  it("is true for iPhone Safari", () => {
    expect(isIosInstallCapable(IPHONE_SAFARI, 5)).toBe(true);
  });

  it("is true for iPadOS 13+ spoofed Macintosh UA with touch points", () => {
    expect(isIosInstallCapable(IPAD_SAFARI_13, 5)).toBe(true);
  });

  it("is false for a real desktop Mac (no touch points)", () => {
    expect(isIosInstallCapable(DESKTOP_MAC_SAFARI, 0)).toBe(false);
  });

  it("is false for Chrome on iOS (CriOS)", () => {
    expect(isIosInstallCapable(IOS_CHROME, 5)).toBe(false);
  });

  it("is false for Firefox on iOS (FxiOS)", () => {
    expect(isIosInstallCapable(IOS_FIREFOX, 5)).toBe(false);
  });

  it("is false for Android Chrome", () => {
    expect(isIosInstallCapable(ANDROID_CHROME, 5)).toBe(false);
  });
});

describe("isInstallPromptDismissed / markInstallPromptDismissed", () => {
  it("reads back a dismissal that was written", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };

    expect(isInstallPromptDismissed(storage)).toBe(false);
    markInstallPromptDismissed(storage);
    expect(store.get(INSTALL_DISMISSED_KEY)).toBe("true");
    expect(isInstallPromptDismissed(storage)).toBe(true);
  });

  it("treats undefined storage as not dismissed and a no-op write", () => {
    expect(isInstallPromptDismissed(undefined)).toBe(false);
    expect(() => markInstallPromptDismissed(undefined)).not.toThrow();
  });

  it("isInstallPromptDismissed never throws when getItem throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {},
    };
    expect(isInstallPromptDismissed(storage)).toBe(false);
  });

  it("markInstallPromptDismissed never throws when setItem throws", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    expect(() => markInstallPromptDismissed(storage)).not.toThrow();
  });
});
