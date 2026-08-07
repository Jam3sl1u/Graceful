/** @jest-environment jsdom */
// Tests for the PWA install banner (#75): components/pwa/InstallPrompt.tsx.
// Drives the Android path via a fake beforeinstallprompt event carrying
// prompt/userChoice, and the iOS path by stubbing navigator.userAgent /
// maxTouchPoints, mirroring tests/unit/app/conflicts-list.test.tsx.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { INSTALL_DISMISSED_KEY } from "@/lib/pwa/install";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

function setUserAgent(userAgent: string, maxTouchPoints = 5) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

function dispatchBeforeInstallPrompt(overrides: {
  prompt?: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}) {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  };
  event.prompt = overrides.prompt ?? (() => Promise.resolve());
  event.userChoice =
    overrides.userChoice ?? Promise.resolve({ outcome: "accepted", platform: "web" });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("InstallPrompt", () => {
  const defaultUserAgent = window.navigator.userAgent;
  const defaultMaxTouchPoints = window.navigator.maxTouchPoints;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    setUserAgent(defaultUserAgent, defaultMaxTouchPoints);
  });

  it("renders nothing before any install signal arrives", () => {
    const { container } = render(<InstallPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when already dismissed in localStorage", () => {
    window.localStorage.setItem(INSTALL_DISMISSED_KEY, "true");
    const { container } = render(<InstallPrompt />);
    dispatchBeforeInstallPrompt({});
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when already running standalone", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;

    const { container } = render(<InstallPrompt />);
    dispatchBeforeInstallPrompt({});
    expect(container).toBeEmptyDOMElement();

    window.matchMedia = originalMatchMedia;
  });

  describe("Android path", () => {
    it("shows the install banner and installs on click", async () => {
      const prompt = jest.fn().mockResolvedValue(undefined);
      render(<InstallPrompt />);

      dispatchBeforeInstallPrompt({
        prompt,
        userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      });

      expect(await screen.findByText("Install Graceful")).toBeInTheDocument();
      expect(
        screen.getByText("Add Graceful to your home screen for one-tap access."),
      ).toBeInTheDocument();
      const installButton = screen.getByRole("button", { name: "Install" });

      fireEvent.click(installButton);

      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.queryByText("Install Graceful")).not.toBeInTheDocument(),
      );
      expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("true");
    });

    it("guards against a second prompt() call on a double click", async () => {
      const prompt = jest.fn().mockResolvedValue(undefined);
      render(<InstallPrompt />);

      dispatchBeforeInstallPrompt({
        prompt,
        userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      });

      const installButton = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(installButton);
      fireEvent.click(installButton);

      await waitFor(() =>
        expect(screen.queryByText("Install Graceful")).not.toBeInTheDocument(),
      );
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("hides the banner without crashing when prompt() rejects", async () => {
      const prompt = jest.fn().mockRejectedValue(new Error("prompt already used"));
      render(<InstallPrompt />);

      dispatchBeforeInstallPrompt({ prompt });

      const installButton = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(installButton);

      await waitFor(() =>
        expect(screen.queryByText("Install Graceful")).not.toBeInTheDocument(),
      );
      expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("true");
    });

    it("dismisses and stays dismissed on unmount/remount", async () => {
      const { unmount } = render(<InstallPrompt />);
      dispatchBeforeInstallPrompt({});

      const dismissButton = await screen.findByRole("button", {
        name: "Dismiss install prompt",
      });
      fireEvent.click(dismissButton);

      expect(screen.queryByText("Install Graceful")).not.toBeInTheDocument();
      expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("true");

      unmount();
      const { container } = render(<InstallPrompt />);
      dispatchBeforeInstallPrompt({});
      expect(container).toBeEmptyDOMElement();
    });

    it("hides the banner and records the dismissal when appinstalled fires", async () => {
      render(<InstallPrompt />);
      dispatchBeforeInstallPrompt({});
      await screen.findByText("Install Graceful");

      act(() => {
        window.dispatchEvent(new Event("appinstalled"));
      });

      await waitFor(() =>
        expect(screen.queryByText("Install Graceful")).not.toBeInTheDocument(),
      );
      expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("true");
    });
  });

  describe("iOS path", () => {
    it("shows Add to Home Screen instructions with no Install button", () => {
      setUserAgent(IPHONE_SAFARI);
      render(<InstallPrompt />);

      expect(screen.getByText("Install Graceful")).toBeInTheDocument();
      expect(
        screen.getByText('Tap the Share button, then "Add to Home Screen".'),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Dismiss install prompt" }),
      ).toBeInTheDocument();
    });

    it("dismiss button hides the iOS banner", () => {
      setUserAgent(IPHONE_SAFARI);
      render(<InstallPrompt />);

      fireEvent.click(screen.getByRole("button", { name: "Dismiss install prompt" }));

      expect(screen.queryByText("Install Graceful")).not.toBeInTheDocument();
      expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("true");
    });
  });
});
