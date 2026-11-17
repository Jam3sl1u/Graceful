"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import {
  isInstallPromptDismissed,
  isIosInstallCapable,
  isRunningStandalone,
  markInstallPromptDismissed,
  type BeforeInstallPromptEvent,
} from "@/lib/pwa/install";
import styles from "./InstallPrompt.module.css";

type Mode = "hidden" | "android" | "ios";

function detectInstallMode(): Mode {
  if (typeof window === "undefined") return "hidden";
  if (
    isRunningStandalone({
      matchMedia: window.matchMedia?.bind(window),
      navigator: window.navigator as unknown as { standalone?: boolean },
    })
  ) {
    return "hidden";
  }
  if (isInstallPromptDismissed(window.localStorage)) return "hidden";
  if (isIosInstallCapable(navigator.userAgent, navigator.maxTouchPoints)) return "ios";
  return "hidden";
}

function subscribeInstallMode() {
  return () => {};
}

export function InstallPrompt(): React.ReactElement | null {
  const detected = useSyncExternalStore(
    subscribeInstallMode,
    detectInstallMode,
    () => "hidden" as const,
  );
  const [override, setOverride] = useState<Mode | null>(null);
  const mode = override ?? detected;
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (
      isRunningStandalone({
        matchMedia: window.matchMedia?.bind(window),
        navigator: window.navigator as unknown as { standalone?: boolean },
      })
    ) {
      return;
    }
    if (isInstallPromptDismissed(window.localStorage)) return;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setOverride("android");
    };

    const handleAppInstalled = () => {
      markInstallPromptDismissed(window.localStorage);
      setOverride("hidden");
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  async function handleInstall() {
    const event = deferred;
    if (!event) {
      setOverride("hidden");
      return;
    }
    // Clear before awaiting: the event is single-use, so a double click must
    // not be able to re-invoke prompt().
    setDeferred(null);
    try {
      await event.prompt();
      await event.userChoice;
    } catch {
      // A rejected/thrown prompt() still finalizes below like any other
      // outcome — the banner must not stay stuck or crash.
    } finally {
      setOverride("hidden");
      markInstallPromptDismissed(window.localStorage);
    }
  }

  function handleDismiss() {
    markInstallPromptDismissed(window.localStorage);
    setOverride("hidden");
  }

  if (mode === "hidden") return null;

  return (
    <div className={styles.banner} role="region" aria-label="Install Graceful">
      <p className={styles.heading}>Install Graceful</p>
      <p className={styles.body}>
        {mode === "android"
          ? "Add Graceful to your home screen for one-tap access."
          : 'Tap the Share button, then "Add to Home Screen".'}
      </p>
      <div className={styles.actions}>
        {mode === "android" && <Button onClick={handleInstall}>Install</Button>}
        <Button
          variant="secondary"
          className={styles.dismiss}
          aria-label="Dismiss install prompt"
          onClick={handleDismiss}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
