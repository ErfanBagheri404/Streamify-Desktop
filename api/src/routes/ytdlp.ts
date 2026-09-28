import type { WorkerConfig } from "../config";
import { pickAudioFormatUrl, pickThumbnailUrl } from "./ytdlp-pick";
import type { YtDlpMetadata } from "./ytdlp-pick";

const YTDLP_TIMEOUT_MS = 25000;

declare const process: any;

export function findYtDlpBinary(): string | null {
  try {
    const envPath =
      typeof process !== "undefined" ? process.env?.STREAMIFY_YTDLP_PATH : "";
    if (envPath) return envPath;
  } catch {}
  const isWin =
    typeof process !== "undefined" && process.platform === "win32";
  const name = isWin ? "yt-dlp.exe" : "yt-dlp";
  // Packaged: resources/bin/ next to the executable.
  try {
    const res =
      typeof process !== "undefined" ? process.resourcesPath : undefined;
    if (typeof res === "string" && res) return `${res}/bin/${name}`;
  } catch {}
  // Dev: repo resources/bin (electron is spawned with the repo as cwd).
  try {
    const cwd =
      typeof process !== "undefined" && typeof process.cwd === "function"
        ? process.cwd()
        : "";
    if (cwd) return `${cwd}/resources/bin/${name}`;
  } catch {}
  // Last resort: whatever is on PATH.
  return "yt-dlp";
}

export function parseYtDlpJson(stdout: string): YtDlpMetadata | null {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {}
    }
    return null;
  }
}

export async function runYtDlpDump(
  videoId: string,
  binary: string
): Promise<YtDlpMetadata | null> {
  let childProcess: any = null;
  try {
    childProcess = await import("node:child_process");
  } catch {
    return null;
  }
  const spawnFn = childProcess?.execFile;
  if (typeof spawnFn !== "function") return null;

  const stdout: string = await new Promise<string>((resolve, reject) => {
    const child = spawnFn(
      binary,
      [
        "-J",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error: any, out: unknown, errText: unknown) => {
        const stderrText = typeof errText === "string" ? errText : "";
        if (error) {
          reject(
            new Error(
              `yt-dlp failed: ${String(
                stderrText || error?.message || error
              ).slice(0, 160)}`
            )
          );
          return;
        }
        resolve(typeof out === "string" ? out : "");
      }
    );
    child?.on?.("error", (e: any) =>
      reject(new Error(`yt-dlp spawn failed: ${e?.message || e}`))
    );
  }).catch((e: unknown) => {
    throw e instanceof Error ? e : new Error(String(e));
  });

  return parseYtDlpJson(stdout);
}

export type YtDlpResult = {
  id: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  lengthSeconds?: number;
  streamUrl: string;
  source: string;
};

export function toYtDlpResult(
  videoId: string,
  metadata: YtDlpMetadata | null,
  source: string
): YtDlpResult | null {
  if (!metadata) return null;
  const streamUrl = pickAudioFormatUrl(metadata.formats);
  if (!streamUrl) return null;
  const title =
    typeof metadata.title === "string" && metadata.title
      ? metadata.title
      : "YouTube";
  const author =
    (typeof metadata.uploader === "string" && metadata.uploader) ||
    (typeof metadata.channel === "string" && metadata.channel) ||
    "YouTube";
  return {
    id:
      typeof metadata.id === "string" && metadata.id ? metadata.id : videoId,
    title,
    author,
    thumbnailUrl: pickThumbnailUrl(metadata),
    lengthSeconds:
      typeof metadata.duration === "number" ? metadata.duration : undefined,
    streamUrl,
    source,
  };
}

export function isDesktopRuntime(): boolean {
  try {
    return typeof process !== "undefined" && !!process.versions?.node;
  } catch {
    return false;
  }
}

export async function resolveYouTubeWithYtDlp(
  _config: WorkerConfig,
  videoId: string,
  source: string
): Promise<YtDlpResult> {
  if (!isDesktopRuntime()) throw new Error("yt-dlp unavailable in worker");
  const binary = findYtDlpBinary();
  if (!binary) throw new Error("yt-dlp binary not found");
  const metadata = await runYtDlpDump(videoId, binary);
  const result = toYtDlpResult(videoId, metadata, source);
  if (!result) throw new Error("yt-dlp returned no playable audio stream");
  return result;
}
