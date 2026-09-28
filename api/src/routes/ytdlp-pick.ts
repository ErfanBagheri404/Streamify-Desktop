import type { WorkerConfig } from "../config";

export type YtDlpFormat = {
  url?: string;
  acodec?: string | null;
  vcodec?: string | null;
  ext?: string;
  abr?: number | null;
  tbr?: number | null;
  protocol?: string;
};

export type YtDlpMetadata = {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
  formats?: YtDlpFormat[];
};

function toNumberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function rateOf(format: YtDlpFormat): number {
  return toNumberOrNull(format.abr) ?? toNumberOrNull(format.tbr) ?? 0;
}

export function pickAudioFormatUrl(
  formats: YtDlpFormat[] | undefined
): string | null {
  if (!Array.isArray(formats) || !formats.length) return null;
  const audioOnly = formats.filter(
    (f) =>
      typeof f?.url === "string" &&
      f.url.length > 0 &&
      (f.vcodec === "none" || f.vcodec == null)
  );
  if (!audioOnly.length) return null;
  const byExt = (ext: string) =>
    audioOnly
      .filter((f) => String(f.ext || "").toLowerCase() === ext)
      .sort((a, b) => rateOf(b) - rateOf(a))[0];
  const pick =
    byExt("m4a") ||
    byExt("mp4") ||
    audioOnly
      .filter((f) => String(f.ext || "").toLowerCase() === "webm")
      .sort((a, b) => rateOf(b) - rateOf(a))[0] ||
    [...audioOnly].sort((a, b) => rateOf(b) - rateOf(a))[0];
  return typeof pick?.url === "string" ? pick.url : null;
}

export function pickThumbnailUrl(metadata: YtDlpMetadata): string {
  if (typeof metadata?.thumbnail === "string" && metadata.thumbnail) {
    return metadata.thumbnail;
  }
  const thumbs = Array.isArray(metadata?.thumbnails)
    ? metadata.thumbnails.filter((t) => typeof t?.url === "string")
    : [];
  return thumbs.length ? String(thumbs[thumbs.length - 1].url) : "";
}
