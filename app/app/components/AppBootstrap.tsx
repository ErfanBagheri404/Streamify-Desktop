"use client";

import { useEffect } from "react";

let appBootstrapStarted = false;

export default function AppBootstrap() {
  useEffect(() => {
    if (appBootstrapStarted) return;
    appBootstrapStarted = true;

    // The desktop shell serves from localhost, which counts as a secure context,
    // so this would register and then serve a stale app shell from cache after
    // an update. Web builds still want it.
    const isDesktopShell = Boolean(window.streamifyDesktop?.isDesktop);

    if (
      process.env.NODE_ENV === "production" &&
      !isDesktopShell &&
      typeof window !== "undefined" &&
      "serviceWorker" in navigator
    ) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return null;
}
