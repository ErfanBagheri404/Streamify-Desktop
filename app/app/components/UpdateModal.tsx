"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppLanguage } from "../hooks/useAppLanguage";

// Desktop-only update prompt. The main process owns electron-updater and pushes
// events over the preload bridge; this component only renders whatever state it
// last reported, so there is no update logic in React. Feature-detected: on the
// web and in dev the bridge is absent and this renders nothing.

type Phase = "available" | "downloading" | "ready" | "error";

const RELEASES_URL = "https://github.com/ErfanBagheri404/Streamify-Desktop/releases";

export default function UpdateModal() {
  const { t } = useAppLanguage();
  const bridge = typeof window !== "undefined" ? window.streamifyDesktop?.update : undefined;
  const currentVersion =
    typeof window !== "undefined" ? window.streamifyDesktop?.version : undefined;

  const [phase, setPhase] = useState<Phase>("available");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Closed until electron-updater reports something; the user can dismiss and
  // is never interrupted again for the same version.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;

    bridge.onAvailable((info) => {
      if (!info?.version) return;
      setVersion(info.version);
      setNotes(info.releaseNotes || null);
      setPhase("available");
      setError(null);
      setPercent(0);
      setOpen(true);
    });
    bridge.onProgress((info) => {
      setPhase("downloading");
      setPercent(Math.max(0, Math.min(100, info?.percent || 0)));
    });
    bridge.onDownloaded(() => {
      setPhase("ready");
      setPercent(100);
    });
    bridge.onError((info) => {
      setError(info?.message || t("update.errorDescription"));
      setPhase("error");
      setOpen(true);
    });
  }, [bridge, t]);

  const startDownload = useCallback(() => {
    setPhase("downloading");
    setPercent(0);
    bridge?.download();
  }, [bridge]);

  const installNow = useCallback(() => {
    bridge?.install();
  }, [bridge]);

  if (!bridge || !open) return null;

  return (
    <div
      className="update-modal-overlay fixed inset-0 z-[80] flex items-center justify-center px-4 py-6"
      style={{ background: "rgba(0, 0, 0, 0.62)", backdropFilter: "blur(10px)" }}
      onClick={phase === "downloading" ? undefined : () => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t("update.availableTitle")}
    >
      <div
        className="update-modal-card theme-surface w-full max-w-lg rounded-3xl border p-6 text-[color:var(--foreground)] shadow-[0_24px_64px_rgba(0,0,0,0.45)] md:p-7"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-xl font-bold text-[color:var(--foreground)]">
            {phase === "ready"
              ? t("update.readyTitle")
              : phase === "error"
                ? t("update.errorTitle")
                : phase === "downloading"
                  ? t("update.downloadingTitle")
                  : t("update.availableTitle")}
          </h2>
          {phase !== "downloading" && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full p-2 transition hover:bg-white/8"
              style={{ color: "var(--muted-foreground)" }}
              aria-label={t("common.close")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>

        <p className="mt-2 text-sm" style={{ color: "var(--muted-foreground)" }}>
          {phase === "ready"
            ? t("update.readyDescription", { version })
            : phase === "error"
              ? error || t("update.errorDescription")
              : phase === "downloading"
                ? t("update.downloadingDescription", { version })
                : t("update.availableDescription", {
                    version,
                    current: currentVersion || "—",
                  })}
        </p>

        {notes && phase === "available" && (
          <div className="theme-surface-strong mt-4 max-h-56 overflow-y-auto rounded-2xl border p-4">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted-foreground)" }}>
              {t("update.releaseNotes")}
            </p>
            <div className="mt-2 space-y-2 text-sm leading-relaxed">
              {notes.split("\n").map((line, i) => {
                const text = line.trim();
                if (!text) return null;
                const isBullet = text.startsWith("• ");
                return (
                  <p key={i} className={isBullet ? "flex gap-2" : ""}>
                    {isBullet && (
                      <span aria-hidden="true" style={{ color: "var(--theme-accent)" }}>
                        •
                      </span>
                    )}
                    <span className={isBullet ? "" : "whitespace-pre-wrap"}>{isBullet ? text.slice(2) : text}</span>
                  </p>
                );
              })}
            </div>
          </div>
        )}

        {phase === "downloading" && (
          <div className="mt-5">
            <div
              className="h-2 w-full overflow-hidden rounded-full"
              style={{ background: "rgba(255,255,255,0.12)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{ width: `${percent}%`, background: "var(--theme-accent)" }}
              />
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--muted-foreground)" }}>
              {Math.round(percent)}%
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          {phase === "available" && (
            <>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full px-4 py-2 text-sm font-medium transition hover:bg-white/8"
                style={{ color: "var(--muted-foreground)" }}
              >
                {t("update.laterButton")}
              </button>
              <button
                type="button"
                onClick={startDownload}
                className="rounded-full px-5 py-2 text-sm font-semibold"
                style={{
                  background: "var(--theme-accent)",
                  color: "var(--theme-accent-contrast)",
                }}
              >
                {t("update.updateButton")}
              </button>
            </>
          )}

          {phase === "ready" && (
            <button
              type="button"
              onClick={installNow}
              className="rounded-full px-5 py-2 text-sm font-semibold"
              style={{
                background: "var(--theme-accent)",
                color: "var(--theme-accent-contrast)",
              }}
            >
              {t("update.restartButton")}
            </button>
          )}

          {phase === "error" && (
            <button
              type="button"
              onClick={() => window.open(RELEASES_URL, "_blank", "noopener,noreferrer")}
              className="rounded-full px-5 py-2 text-sm font-semibold"
              style={{
                background: "var(--theme-accent)",
                color: "var(--theme-accent-contrast)",
              }}
            >
              {t("update.openReleases")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
