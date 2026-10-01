// components/OverlayTitleBar.tsx
"use client";

import { useEffect, useState } from "react";

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      {direction === "left" ? (
        <path d="M15 18l-6-6 6-6" />
      ) : (
        <path d="M9 18l6-6-6-6" />
      )}
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

/** The Navigation API surface this strip needs. The DOM lib does not ship
 * `window.navigation` typings yet, so declare just what is used. */
interface NavHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  back(): void;
  forward(): void;
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

/**
 * The strip drawn INSIDE the window. The native title bar and the old menu
 * bar row are both hidden, so this is the only surface for the application
 * menu and for history navigation.
 *
 * History comes from the renderer's own Navigation API rather than an IPC
 * round-trip to main: it is the same session history, but it reports
 * pushState navigations (which is how Next routes) and emits change events,
 * so the chevrons enable/disable without polling.
 *
 * The window has no title bar to drag, so the whole strip is a drag region
 * (buttons opt out with no-drag) and its background is a real panel with a
 * divider underneath — the OS caption buttons sit in the top-right corner of
 * this same strip.
 */
export default function OverlayTitleBar() {
  // Web build has no bridge: render nothing. The desktop shell reserves the
  // top inset from a pre-paint script, so the strip simply appears one frame
  // later with no layout shift.
  const [isDesktop, setIsDesktop] = useState(false);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });

  useEffect(() => {
    if (!window.streamifyDesktop?.titleBar) return;
    setIsDesktop(true);

    // `window.navigation` is not in the DOM lib yet, so reach for it through
    // the global scope and narrow by capability.
    const navigation = (globalThis as { navigation?: NavHistory }).navigation;
    if (!navigation) return;
    const sync = () =>
      setNav({
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
      });
    sync();
    navigation.addEventListener("currententrychange", sync);
    return () => navigation.removeEventListener("currententrychange", sync);
  }, []);

  if (!isDesktop) return null;

  const buttonClass =
    "flex h-7 w-7 items-center justify-center rounded-md text-[color:color-mix(in_srgb,var(--foreground)_78%,transparent)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--foreground)_10%,transparent)] hover:text-[color:var(--foreground)] disabled:pointer-events-none disabled:opacity-30";

  return (
    <div
      data-overlay-bar=""
      className="fixed inset-x-0 top-0 z-[90] flex h-9 items-center justify-between border-b border-[color:color-mix(in_srgb,var(--foreground)_10%,transparent)] px-2"
      style={
        {
          WebkitAppRegion: "drag",
          backgroundColor: "var(--background)",
        } as React.CSSProperties
      }
    >
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          aria-label="Menu"
          title="Menu"
          className={buttonClass}
          onClick={() => window.streamifyDesktop?.titleBar?.openMenu()}
        >
          <DotsIcon />
        </button>
        <button
          type="button"
          aria-label="Back"
          title="Back"
          className={buttonClass}
          disabled={!nav.canGoBack}
          onClick={() => (globalThis as { navigation?: NavHistory }).navigation?.back()}
        >
          <Chevron direction="left" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          className={buttonClass}
          disabled={!nav.canGoForward}
          onClick={() => (globalThis as { navigation?: NavHistory }).navigation?.forward()}
        >
          <Chevron direction="right" />
        </button>
      </div>
      {/* Right side stays empty: the OS caption buttons (minimize / restore /
          close) are drawn by the window frame in this corner. */}
    </div>
  );
}
