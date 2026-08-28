// Pure, DOM-free-where-possible helpers backing the PWA install prompt
// (components/pwa/InstallPrompt.tsx). This module does not touch `window`,
// `navigator`, or `localStorage` directly at import time — every browser API
// it needs is passed in by the caller, so the logic here is exhaustively
// unit-testable without a browser. See lib/invitations/state-machine.ts for
// the sibling pattern this follows.

export const INSTALL_DISMISSED_KEY = "graceful:pwa-install-dismissed";

// Chrome's non-standard install event. Not in lib.dom, so declare it here.
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type StandaloneWindow = {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
};

type DismissalStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * True when the page is already running as an installed app:
 * `(display-mode: standalone)` matches (Android/Chrome) or the non-standard
 * `navigator.standalone` is true (iOS Safari). Tolerates a missing matchMedia.
 */
export function isRunningStandalone(win: StandaloneWindow): boolean {
  const matchesDisplayMode = win.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const isIosStandalone = win.navigator?.standalone === true;
  return matchesDisplayMode || isIosStandalone;
}

/**
 * True only for iOS/iPadOS in a browser that can actually "Add to Home Screen"
 * (Safari). iPadOS 13+ reports a "Macintosh" UA, hence the maxTouchPoints arg.
 */
export function isIosInstallCapable(userAgent: string, maxTouchPoints: number): boolean {
  const isIosDevice =
    /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (!isIosDevice) return false;

  // Chrome/Firefox/Edge/Opera on iOS cannot add to the home screen.
  const isNonSafariIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
  if (isNonSafariIosBrowser) return false;

  return true;
}

/** Never throws — a storage failure reads as "not dismissed". */
export function isInstallPromptDismissed(storage: DismissalStorage | undefined): boolean {
  try {
    return storage?.getItem(INSTALL_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Never throws. */
export function markInstallPromptDismissed(storage: DismissalStorage | undefined): void {
  try {
    storage?.setItem(INSTALL_DISMISSED_KEY, "true");
  } catch {
    // Storage unavailable (e.g. Safari private mode) — nothing more to do.
  }
}
