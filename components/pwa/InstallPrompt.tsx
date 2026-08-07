"use client";

import { useEffect, useState } from "react";
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

export function InstallPrompt(): React.ReactElement | null {
  const [mode, setMode] = useState<Mode>("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // `navigator.standalone` is a real, long-standing iOS Safari property
    // that lib.dom.d.ts intentionally doesn't type (it's non-standard) — the
    // cast is narrowly scoped to that gap, not a workaround for our own code.
    if (
      isRunningStandalone({
        matchMedia: window.matchMedia?.bind(window),
        navigator: window.navigator as unknown as { standalone?: boolean },
      })
    )
      return;
    if (isInstallPromptDismissed(window.localStorage)) return;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setMode("android");
    };

    const handleAppInstalled = () => {
      markInstallPromptDismissed(window.localStorage);
      setMode("hidden");
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    if (isIosInstallCapable(navigator.userAgent, navigator.maxTouchPoints)) {
      setMode("ios");
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  async function handleInstall() {
    const event = deferred;
    if (!event) {
      setMode("hidden");
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
      setMode("hidden");
      markInstallPromptDismissed(window.localStorage);
    }
  }

  function handleDismiss() {
    markInstallPromptDismissed(window.localStorage);
    setMode("hidden");
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
