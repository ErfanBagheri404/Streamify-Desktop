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

// A bare score floor accepts garbage: substring hits ("Blinding Lights" in
// "Blinding Lights (Bongo Cat Edit)") and one shared artist token score high
// enough to pass, so a MISSING track silently became an unrelated one. Gate on
// identity instead — the candidate must demonstrably BE the requested track.
type CandidateIdentity = {
  title: string;
  artist: string;
  duration?: number;
};

function titlesAreSameSong(expected: string, actual: string): boolean {
  const left = normalizeComparisonText(expected);
  const right = normalizeComparisonText(actual);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter >= 6 && shorter / longer >= 0.6) {
    if (left.includes(right) || right.includes(left)) return true;
  }

  const expectedWords = left.split(" ").filter(Boolean);
  if (expectedWords.length < 2) return false;
  const actualWords = new Set(right.split(" ").filter(Boolean));
  let overlap = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) overlap += 1;
  }
  return overlap >= 2 && overlap / expectedWords.length >= 0.75;
}

function artistsAreCompatible(expected: string, actual: string): boolean {
  const left = normalizeComparisonText(expected);
  const right = normalizeComparisonText(actual);
  if (!left || !right) return true;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  // Multi-artist rows ("Artist, Other") vs a single-artist upload: require a
  // real token, not a one-character fragment.
  return right
    .split(" ")
    .filter(Boolean)
    .some((token) => token.length >= 3 && left.includes(token));
}

export function isVerifiedTrackMatch(
  track: Pick<ExternalCatalogTrack, "title" | "artist" | "duration">,
  candidate: CandidateIdentity,
): boolean {
  if (!titlesAreSameSong(track.title, candidate.title)) return false;
  if (!artistsAreCompatible(track.artist, candidate.artist)) return false;

  if (
    typeof track.duration === "number" &&
    typeof candidate.duration === "number" &&
    track.duration > 0 &&
    candidate.duration > 0
  ) {
    if (Math.abs(track.duration - candidate.duration) > 12) return false;
  }

  return true;
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

      // Keep only candidates that actually are the requested track, then let
            // the fuzzy score pick the best of those survivors. Taking ranked[0] and
            // validating it second lets a high-scoring near-miss shadow a correct hit
            // further down the list.
            const verified = ranked.filter((entry) =>
              isVerifiedTrackMatch(track, entry)
            );
            const bestMatch = verified[0];
            if (!bestMatch) continue;
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

/**
 * Catalog track that found NO verified streaming source.
 *
 * Before this, unmatched tracks were dropped from the result list, which made
 * search look like a catalogue hole and pushed the caller into guessing a
 * substitute. Keep the row with its native provider id and let playback
 * resolve it later through the JioSaavn -> YouTube -> SoundCloud chain.
 */
export function buildCatalogFallbackTrack(
  track: ExternalCatalogTrack,
): Record<string, unknown> {
  const thumbnailUrl = track.coverUrl?.trim() || "";
  return {
    id: track.id,
    title: track.title,
    name: track.title,
    artist: track.artist,
    primaryArtists: track.artist,
    album: track.album,
    duration: track.duration,
    image: thumbnailUrl ? [{ url: thumbnailUrl }] : [],
    thumbnailUrl,
    thumbnail: thumbnailUrl,
    coverUrl: thumbnailUrl,
    img: thumbnailUrl,
    source: track.provider,
    type: "song",
    providerHint: track.provider,
    isPlayable: true,
    url: buildCatalogTrackPageUrl(track),
  };
}

function buildCatalogTrackPageUrl(track: ExternalCatalogTrack): string {
  if (!track.id) return "";
  if (track.provider === "spotify") {
    return `https://open.spotify.com/track/${track.id}`;
  }
  if (track.provider === "deezer") {
    return `https://www.deezer.com/track/${track.id}`;
  }
  if (track.provider === "itunes") {
    return `https://music.apple.com/us/album/${track.id}`;
  }
  return "";
}
