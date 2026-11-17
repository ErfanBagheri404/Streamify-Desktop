"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppLanguage } from "../hooks/useAppLanguage";

// Desktop-only update prompt. The main process owns electron-updater and pushes
// events over the preload bridge; this component only renders whatever state it
// last reported, so there is no update logic in React. Feature-detected: on the
// web and in dev the bridge is absent and this renders nothing.

type Phase = "available" | "downloading" | "ready" | "error";

const RELEASES_URL = "https://github.com/ErfanBagheri404/Streamify-Desktop/releases";

const short = (version?: string) => (version || "").replace(/^v/i, "");

function Step({ index, active, done, label }: { index: number; active: boolean; done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      {index > 0 && (
        <span
          aria-hidden="true"
          className="h-px w-5"
          style={{ background: done || active ? "var(--theme-accent)" : "var(--border-subtle)" }}
        />
      )}
      <span
        className={`flex items-center gap-1.5 ${done ? "text-[color:var(--theme-accent)]" : active ? "font-bold text-[color:var(--foreground)]" : "text-[color:var(--muted-foreground)]"}`}
      >
        <span
          className="grid size-4 place-items-center rounded-full text-[10px]"
          style={
            done || active
              ? {
                  background: "var(--theme-accent)",
                  color: "var(--theme-accent-contrast)",
                  boxShadow: active ? "0 0 0 2px color-mix(in srgb, var(--theme-accent) 30%, transparent)" : undefined,
                }
              : { background: "var(--surface-3)", color: "var(--muted-foreground)" }
          }
        >
          {done ? (
            <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
            </svg>
          ) : (
            index + 1
          )}
        </span>
        {label}
      </span>
    </li>
  );
}

export default function UpdateModal() {
  const { t, dir } = useAppLanguage();
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
      setPercent(100);
      setPhase("ready");
      setOpen(true);
    });
    bridge.onError((info) => {
      setError(info?.message || t("update.errorDescription"));
      setPhase("error");
      setOpen(true);
    });
  }, [bridge, t]);

  const busy = phase === "downloading";
  const dismiss = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  useEffect(() => {
    if (!open || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  const startDownload = useCallback(() => {
    setPhase("downloading");
    setPercent(0);
    bridge?.download();
  }, [bridge]);

  const installNow = useCallback(() => {
    bridge?.install();
  }, [bridge]);

  if (!bridge || !open) return null;

  const title =
    phase === "ready"
      ? t("update.readyTitle")
      : phase === "error"
        ? t("update.errorTitle")
        : phase === "downloading"
          ? t("update.downloadingTitle")
          : t("update.availableTitle");

  const description =
    phase === "ready"
      ? t("update.readyDescription", { version })
      : phase === "error"
        ? t("update.errorDescription")
        : phase === "downloading"
          ? t("update.downloadingDescription", { version })
          : t("update.availableDescription", { version, current: currentVersion || "-" });

  const rounded = Math.round(percent);
  const restarted = phase === "ready";
  const cardClass =
    "update-modal-card theme-surface w-full max-w-4xl overflow-hidden rounded-3xl border text-[color:var(--foreground)] shadow-[0_24px_64px_rgba(0,0,0,0.45)]";
  // buttons always start at the leading edge of the row,
  // never at the trailing end, regardless of LTR/RTL.
  const buttonJustify = "flex-start";

  return (
    <div
      className="update-modal-overlay fixed inset-0 z-[80] flex items-center justify-center px-4 py-6"
      style={{ background: "rgba(0, 0, 0, 0.62)", backdropFilter: "blur(10px)" }}
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        dir={dir}
        className={cardClass}
        style={{ maxHeight: "calc(100vh - 3rem)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="grid max-h-[calc(100vh-3rem)] grid-cols-1 sm:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="flex min-h-0 flex-col gap-5 p-6 md:p-7">
            <div className="flex flex-col gap-2">
              <span
                className="flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                style={
                  phase === "error"
                    ? { background: "rgba(248,113,113,0.15)", color: "#fca5a5" }
                    : {
                        background: "color-mix(in srgb, var(--theme-accent) 18%, transparent)",
                        color: "var(--theme-accent)",
                      }
                }
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                {phase === "error" ? t("update.errorTitle") : t("update.newBadge")}
              </span>
              <h2 className="text-2xl font-black leading-tight">{title}</h2>
              <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                {description}
              </p>
            </div>

            {notes && phase === "available" && (
              <div
                className="theme-surface-strong min-h-0 flex-1 overflow-y-auto rounded-2xl border p-4"
                style={{ maxHeight: "16rem" }}
              >
                <p
                  className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--muted-foreground)" }}
                >
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
                        <span className={isBullet ? "" : "whitespace-pre-wrap"}>
                          {isBullet ? text.slice(2) : text}
                        </span>
                      </p>
                    );
                  })}
                </div>
              </div>
            )}

            {phase === "error" && (
              <div
                className="rounded-2xl p-3 text-xs"
                style={{ background: "rgba(248,113,113,0.1)", color: "#fca5a5" }}
              >
                {error || t("update.errorDescription")}
              </div>
            )}

            {(busy || restarted) && (
              <div
                className="flex flex-col gap-3 rounded-2xl p-4"
                style={{ background: "var(--surface-3)" }}
              >
                <ol className="flex items-center gap-2 text-xs">
                  <Step index={0} active={false} done label={t("update.stepDownload")} />
                  <Step index={1} active={restarted} done={false} label={t("update.stepRestart")} />
                </ol>
                <div
                  className="relative h-2 overflow-hidden rounded-full"
                  style={{ background: "var(--background)" }}
                  role="progressbar"
                  aria-valuenow={restarted ? 100 : rounded}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="absolute inset-y-0 start-0 rounded-full transition-[width] duration-200 ease-out"
                    style={{ width: `${restarted ? 100 : rounded}%`, background: "var(--theme-accent)" }}
                  />
                </div>
                <div
                  className="flex items-center justify-between gap-3 text-xs"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  <span>
                    {restarted
                      ? t("update.restartHint")
                      : rounded > 0
                        ? t("update.progressLabel", { percent: rounded })
                        : t("update.starting")}
                  </span>
                  <span className="font-bold tabular-nums" style={{ color: "var(--foreground)" }}>
                    {restarted ? "100%" : `${rounded}%`}
                  </span>
                </div>
              </div>
            )}

            <div className="mt-auto flex flex-wrap gap-3" style={{ justifyContent: buttonJustify }}>
              {phase === "available" && (
                <>
                  <button
                    type="button"
                    onClick={dismiss}
                    className="h-11 rounded-full px-5 text-sm font-medium transition hover:bg-white/8"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {t("update.laterButton")}
                  </button>
                  <button
                    type="button"
                    onClick={startDownload}
                    className="flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:brightness-110"
                    style={{ background: "var(--theme-accent)", color: "var(--theme-accent-contrast)" }}
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" />
                    </svg>
                    {t("update.updateButton")}
                  </button>
                </>
              )}

              {phase === "ready" && (
                <button
                  type="button"
                  onClick={installNow}
                  className="flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:brightness-110"
                  style={{ background: "var(--theme-accent)", color: "var(--theme-accent-contrast)" }}
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
                  </svg>
                  {t("update.restartButton")}
                </button>
              )}

              {phase === "error" && (
                <>
                  <button
                    type="button"
                    onClick={dismiss}
                    className="h-11 rounded-full px-5 text-sm font-medium transition hover:bg-white/8"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {t("update.laterButton")}
                  </button>
                  <button
                    type="button"
                    onClick={() => window.open(RELEASES_URL, "_blank", "noopener,noreferrer")}
                    className="flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:brightness-110"
                    style={{ background: "var(--theme-accent)", color: "var(--theme-accent-contrast)" }}
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 4h6m0 0v6m0-6L10 14M9 5H6a2 2 0 0 0-2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
                    </svg>
                    {t("update.openReleases")}
                  </button>
                </>
              )}
            </div>
          </div>

          <div
            className="relative hidden min-h-48 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-white sm:flex"
            style={{
              background: "#0b0b0d",
              backgroundImage:
                "radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--theme-accent) 42%, transparent) 0%, transparent 70%), linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)",
              backgroundSize: "100% 100%, 28px 28px, 28px 28px",
            }}
          >
            <div className="relative">
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-3xl blur-2xl"
                style={{ background: "color-mix(in srgb, var(--theme-accent) 60%, transparent)" }}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                src="/StreamifyLogo.svg"
                className="relative size-16 rounded-3xl p-2 shadow-2xl ring-1 ring-white/15"
                style={{ background: "rgba(255,255,255,0.06)" }}
              />
            </div>
            <div className="flex flex-col items-center gap-1">
              <span className="text-xs tracking-wide text-white/70">{t("update.newVersionLabel")}</span>
              <span dir="ltr" className="text-5xl font-black tabular-nums">
                {short(version) || "—"}
              </span>
            </div>
            {currentVersion && (
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 ring-1 ring-white/10 backdrop-blur">
                {t("update.onVersion", { current: short(currentVersion) })}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
