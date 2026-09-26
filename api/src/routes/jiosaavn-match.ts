import { buildProviderUrlCandidates, type WorkerConfig } from "../config";
import { toArray, toNumber, toRecord, withTimeout } from "../http";

export type ExternalCatalogTrack = {
  provider: string;
  id: string;
  title: string;
  artist: string;
  coverUrl?: string;
  duration?: number;
  album?: string;
};

export type JioSaavnPlaybackMatch = {
  item: Record<string, unknown>;
  id: string;
  url?: string;
  title: string;
  artist: string;
  duration?: number;
};

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreWordOverlap(
  expected: string,
  actual: string,
  weight: number,
): number {
  const expectedWords = normalizeComparisonText(expected)
    .split(" ")
    .filter(Boolean);
  const actualWords = new Set(
    normalizeComparisonText(actual).split(" ").filter(Boolean),
  );

  if (expectedWords.length === 0 || actualWords.size === 0) return 0;

  let matches = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) matches += 1;
  }

  return matches * weight;
}

function scoreTextMatch(expected: string, actual: string): number {
  const normalizedExpected = normalizeComparisonText(expected);
  const normalizedActual = normalizeComparisonText(actual);
  if (!normalizedExpected || !normalizedActual) return 0;

  if (normalizedExpected === normalizedActual) return 120;
  if (
    normalizedExpected.includes(normalizedActual) ||
    normalizedActual.includes(normalizedExpected)
  ) {
    return 80;
  }

  return scoreWordOverlap(expected, actual, 18);
}

function scoreArtistMatch(expected: string, actual: string): number {
  const normalizedExpected = normalizeComparisonText(expected);
  const normalizedActual = normalizeComparisonText(actual);
  if (!normalizedExpected || !normalizedActual) return 0;

  if (normalizedExpected === normalizedActual) return 70;
  if (
    normalizedExpected.includes(normalizedActual) ||
    normalizedActual.includes(normalizedExpected)
  ) {
    return 42;
  }

  return scoreWordOverlap(expected, actual, 10);
}

function extractItemTitle(item: Record<string, unknown>): string {
  const candidates = [item.title, item.song, item.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function extractItemArtist(item: Record<string, unknown>): string {
  const candidates = [
    item.primaryArtists,
    item.primary_artists,
    item.artist,
    item.singers,
    item.subtitle,
    item.description,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const artistsRecord = toRecord(item.artists);
  const primaryArtists = toArray(artistsRecord.primary)
    .map((entry) => {
      const record = toRecord(entry);
      return typeof record.name === "string" ? record.name.trim() : "";
    })
    .filter(Boolean);
  return primaryArtists.join(", ");
}

function extractItemId(item: Record<string, unknown>): string {
  const rawId = item.id ?? item.videoId ?? item.identifier;
  if (typeof rawId === "string" && rawId.trim()) return rawId.trim();
  if (typeof rawId === "number" && Number.isFinite(rawId)) return String(rawId);
  return "";
}

function extractItemUrl(item: Record<string, unknown>): string | undefined {
  const candidates = [item.url, item.permalink_url];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractItemDuration(
  item: Record<string, unknown>,
): number | undefined {
  const numeric = toNumber(item.duration);
  if (numeric == null) return undefined;
  return numeric > 10000 ? Math.round(numeric / 1000) : Math.round(numeric);
}

function extractSongResults(payload: unknown): Array<Record<string, unknown>> {
  const record = toRecord(payload);
  const data = toRecord(record.data);
  const songs = toRecord(data.songs);

  const directSongResults = toArray(songs.results).map((entry) =>
    toRecord(entry),
  );
  if (directSongResults.length > 0) return directSongResults;

  const dataResults = toArray(data.results).map((entry) => toRecord(entry));
  if (dataResults.length > 0) return dataResults;

  const topLevelResults = toArray(record.results).map((entry) =>
    toRecord(entry),
  );
  if (topLevelResults.length > 0) return topLevelResults;

  return toArray(payload).map((entry) => toRecord(entry));
}

function isStrongEnoughMatch(
  score: number,
  track: ExternalCatalogTrack,
): boolean {
  const hasArtist = Boolean(track.artist.trim());
  return score >= (hasArtist ? 80 : 60);
}

function normalizeImageArray(
  coverUrl: string | undefined,
  fallback: unknown,
): Array<Record<string, unknown>> {
  const images = toArray(fallback)
    .map((entry) => toRecord(entry))
    .filter((entry) => typeof entry.url === "string" && entry.url.trim());
  const normalizedCover = coverUrl?.trim() || "";
  if (!normalizedCover) return images;

  return [
    {
      quality: "500x500",
      width: 500,
      height: 500,
      url: normalizedCover,
    },
    ...images.filter((entry) => entry.url !== normalizedCover),
  ];
}

function bestImageUrl(images: Array<Record<string, unknown>>): string {
  for (const image of images) {
    if (typeof image.url === "string" && image.url.trim()) {
      return image.url;
    }
  }
  return "";
}

export async function findJioSaavnPlayback(
  config: WorkerConfig,
  track: ExternalCatalogTrack,
  signal: AbortSignal | undefined,
): Promise<JioSaavnPlaybackMatch | null> {
  const query = [track.title, track.artist].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const candidates = [
    ...buildProviderUrlCandidates(
      config.providers.jiosaavn.apiBase,
      ["/api/search", "/search"],
      { query },
    ),
    ...buildProviderUrlCandidates(
      config.providers.jiosaavn.fallbackSearchBase,
      ["/api/search", "/search"],
      { query },
    ),
  ];

  for (const apiUrl of candidates) {
    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: "application/json" },
        signal: withTimeout(signal, 9000),
      });
      if (!response.ok) continue;

      const songs = extractSongResults(await response.json());
      if (songs.length === 0) continue;

      const ranked = songs
        .map((item) => {
          const id = extractItemId(item);
          const title = extractItemTitle(item);
          const artist = extractItemArtist(item);
          const score =
            scoreTextMatch(track.title, title) +
            scoreArtistMatch(track.artist, artist);
          return {
            item,
            id,
            url: extractItemUrl(item),
            title,
            artist,
            duration: extractItemDuration(item),
            score,
          };
        })
        .filter((entry) => entry.id || entry.url)
        .sort((left, right) => right.score - left.score);

      const bestMatch = ranked[0];
      if (!bestMatch) continue;
      if (!isStrongEnoughMatch(bestMatch.score, track)) continue;
      if (!bestMatch.id) continue;

      return {
        item: bestMatch.item,
        id: bestMatch.id,
        url: bestMatch.url,
        title: bestMatch.title,
        artist: bestMatch.artist,
        duration: bestMatch.duration,
      };
    } catch {
      continue;
    }
  }

  return null;
}

export function buildJioSaavnStyleTrack(
  track: ExternalCatalogTrack,
  match: JioSaavnPlaybackMatch,
): Record<string, unknown> {
  const images = normalizeImageArray(track.coverUrl, match.item.image);
  const thumbnailUrl = bestImageUrl(images);
  const primaryArtists =
    typeof match.item.primaryArtists === "string" &&
    match.item.primaryArtists.trim()
      ? match.item.primaryArtists
      : track.artist || match.artist;

  return {
    ...match.item,
    id: match.id,
    url: match.url ?? `/song/${match.id}`,
    source: "jiosaavn",
    type: "song",
    title: track.title || match.title,
    name: track.title || match.title,
    artist: track.artist || match.artist,
    primaryArtists,
    image: images,
    thumbnailUrl,
    thumbnail: thumbnailUrl,
    coverUrl: thumbnailUrl,
    img: thumbnailUrl,
    duration: track.duration ?? match.duration,
    album:
      track.album ||
      (typeof match.item.album === "string" ? match.item.album : undefined),
    providerHint: track.provider,
  };
}
