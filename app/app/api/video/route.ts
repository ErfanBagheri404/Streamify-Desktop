import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireStreamifyRequest } from "../_lib/request-guard";
import {
  getInvidiousInstances,
  getPipedInstances,
} from "../../lib/media-providers";
import {
  buildProviderUrlCandidates,
  getCachedProviderEndpointsSnapshot,
  getProviderEndpoints,
} from "../../lib/provider-endpoints";
import {
  extractYouTubeVideoId,
  normalizeYouTubeThumbnailUrl,
} from "../../lib/youtube-thumbnails";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const cache = new Map<string, { at: number; value: Record<string, unknown> }>();
const inflightRequests = new Map<string, Promise<Record<string, unknown>>>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_CACHE_TTL_MS = 60 * 60 * 1000;
const YOUTUBE_PROVIDER_HINT_TTL_MS = 24 * 60 * 60 * 1000;
const INVIDIOUS_TIMEOUT_MS = 10000;
const PIPED_TIMEOUT_MS = 7000;
const execFileAsync = promisify(execFile);
const preferredYouTubeProviders = new Map<
  string,
  { label: string; cachedAt: number }
>();

type VideoProvider = {
  label: string;
  run: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
};

function reportDebugEvent(
  _runId: string,
  _hypothesisId: string,
  _location: string,
  _msg: string,
  _data: Record<string, unknown>,
) {
  // Debug event reporting disabled. Kept as a no-op so call sites stay intact.
}

function normalizeYouTubeSourceKey(source?: string): string {
  return source === "youtubemusic" ? "youtubemusic" : "youtube";
}

function readPreferredYouTubeProvider(source?: string): string | null {
  const sourceKey = normalizeYouTubeSourceKey(source);
  const cached = preferredYouTubeProviders.get(sourceKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > YOUTUBE_PROVIDER_HINT_TTL_MS) {
    preferredYouTubeProviders.delete(sourceKey);
    return null;
  }
  return cached.label;
}

function writePreferredYouTubeProvider(
  source: string | undefined,
  label: string,
) {
  if (!label) return;
  preferredYouTubeProviders.set(normalizeYouTubeSourceKey(source), {
    label,
    cachedAt: Date.now(),
  });
}

function parseYouTubeProviderHints(
  hintValue: string | undefined,
  source?: string,
): string[] {
  const requestedHints = (hintValue || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const cachedHint = readPreferredYouTubeProvider(source);
  return [...new Set([cachedHint, ...requestedHints].filter(Boolean))];
}

function prioritizeVideoProviders(
  providers: VideoProvider[],
  preferredHints: string[],
): VideoProvider[] {
  if (preferredHints.length === 0) return providers;

  const preferred = providers.filter((provider) =>
    preferredHints.includes(provider.label),
  );
  const fallback = providers.filter(
    (provider) => !preferredHints.includes(provider.label),
  );
  return [...preferred, ...fallback];
}

async function tryVideoProvidersSequentially(
  providers: VideoProvider[],
  runId: string,
  source?: string,
): Promise<Record<string, unknown> | null> {
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const value = await provider.run(controller.signal);
      controller.abort();
      writePreferredYouTubeProvider(source, provider.label);
      return {
        ...value,
        providerHint: provider.label,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider.label}: ${message}`);
      reportDebugEvent(
        runId,
        "H4",
        "app/api/video/route.ts:fetchVideoDetails:provider-failure",
        "[DEBUG] YouTube provider attempt failed",
        {
          source: source || "youtube",
          provider: provider.label,
          error: message,
        },
      );
    }
  }

  if (errors.length === 0) return null;
  throw new Error(errors.join(" | "));
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );

  return controller.signal;
}

function absolutizeUrl(url: string, base: string): string {
  if (!url) return url;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${base}${url}`;
  return url;
}

function isAudioMime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.includes("audio/");
}

function toRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function toArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseJsonText(
  text: string,
  errorMessage = "Invalid JSON response",
): unknown {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  if (!normalized) return null;

  try {
    return JSON.parse(normalized);
  } catch {
    const firstObject = normalized.indexOf("{");
    const firstArray = normalized.indexOf("[");
    const startCandidates = [firstObject, firstArray].filter(
      (value) => value >= 0,
    );
    const lastObject = normalized.lastIndexOf("}");
    const lastArray = normalized.lastIndexOf("]");
    const end = Math.max(lastObject, lastArray);

    if (startCandidates.length > 0 && end >= 0) {
      const start = Math.min(...startCandidates);
      if (end > start) {
        return JSON.parse(normalized.slice(start, end + 1));
      }
    }

    throw new Error(errorMessage);
  }
}

async function fetchTextWithHeaders(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  try {
    const res = await fetch(url, {
      headers,
      cache: "no-store",
      signal: withTimeout(undefined, timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
      );
    }
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldTryPowerShell =
      process.platform === "win32" &&
      (/fetch failed|ECONNRESET|aborted|UND_ERR_CONNECT_TIMEOUT/i.test(
        message,
      ) ||
        message.includes("This operation was aborted"));

    if (!shouldTryPowerShell) {
      throw error;
    }

    return fetchTextViaPowerShell(url, headers, timeoutMs);
  }
}

function buildDirectProxyAudioUrl(streamUrl: string | null): string | null {
  if (!streamUrl) return null;
  return `/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`;
}

function buildSoundCloudWidevineLicenseUrl(
  licenseBase: string,
  licenseAuthToken: string,
): string {
  return (
    buildProviderUrlCandidates(licenseBase, ["/playback/widevine"], {
      license_token: licenseAuthToken,
    })[0] || ""
  );
}

function isSoundCloudEncryptedStreamUrl(streamUrl: string): boolean {
  try {
    return /\/(cbcs|cenc)\//i.test(new URL(streamUrl).pathname);
  } catch {
    return false;
  }
}

function pickArrayString(entry: unknown, keys: string[]): string | undefined {
  const record = toRecord(entry);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function qualityScore(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/(\d+)/);
    if (match) return Number(match[1]);
  }
  return 0;
}

function getJioSaavnRecords(payload: unknown): Record<string, any>[] {
  const queue: unknown[] = [payload];
  const records: Record<string, any>[] = [];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = toRecord(current);
    if (!Object.keys(record).length) continue;
    records.push(record);

    queue.push(
      record.data,
      record.song,
      record.songs,
      record.results,
      record.more_info,
    );
  }

  return records;
}

function pickJioSaavnImage(value: unknown): string | undefined {
  const images = toArray(value).map((entry) => toRecord(entry));
  if (!images.length) return undefined;

  return (
    images
      .sort(
        (a, b) =>
          qualityScore(b.quality || b.size) - qualityScore(a.quality || a.size),
      )
      .map((entry) => pickArrayString(entry, ["url", "link"]))
      .find(Boolean) || undefined
  );
}

function pickJioSaavnArtistNames(
  record: Record<string, any>,
): string | undefined {
  const direct = pickArrayString(record, [
    "primary_artists",
    "primaryArtists",
    "singers",
    "artist",
    "subtitle",
  ]);
  if (direct) return direct;

  const artists = toRecord(record.artists);
  const groups = [artists.primary, artists.featured, artists.all];

  for (const group of groups) {
    const names = toArray(group)
      .map((entry) => pickArrayString(entry, ["name"]))
      .filter(Boolean);
    if (names.length) return names.join(", ");
  }

  return undefined;
}

function normalizeForMatch(value?: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(
      /\b(feat|ft|featuring|official|video|lyrics|audio|visualizer)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Like normalizeForMatch but KEEPS parenthesised text. SoundCloud uploads
 * carry featured artists inside brackets ("Behzad Leito - Peida Nakardam
 * (Ft Anita)"), and normalizeForMatch strips those brackets entirely, which
 * would hide the featured artist from the artist-presence check.
 */
function normalizeKeepingBrackets(value?: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(feat|ft|featuring|official|video|lyrics|audio|visualizer)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function primaryArtist(artist?: string): string {
  return String(artist || "")
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b/i)[0]
    .trim();
}

/**
 * ONE identity gate for every metadata->stream lookup (JioSaavn, YouTube,
 * SoundCloud). A fuzzy score floor is what let a MISSING song play an unrelated
 * one, so a candidate must actually BE the requested song before we return it.
 */
/**
 * SoundCloud titles routinely read "Artist - Track". Treat the artist as
 * present when every meaningful token of the wanted artist appears in the
 * candidate title, so a fan re-upload still counts as the same recording.
 */
function artistMatchIsInTitle(
  wantedArtist: string | undefined,
  candidateTitle: string,
): boolean {
  const primary = primaryArtist(wantedArtist);
  const expected = normalizeForMatch(primary);
  if (!expected) return false;
  const actual = normalizeKeepingBrackets(candidateTitle);
  if (!actual) return false;
  const tokens = expected.split(" ").filter((part) => part.length >= 3);
  if (!tokens.length) return false;
  // Every meaningful token of the PRIMARY artist must appear in the title.
  return tokens.every((part) => actual.includes(part));
}

function isVerifiedMetadataMatch(
  wanted: { title: string; artist?: string; duration?: number },
  candidate: { title: string; artist?: string; duration?: number },
): boolean {
  const left = normalizeForMatch(wanted.title);
  const right = normalizeForMatch(candidate.title);
  if (!left || !right) return false;

  const exact = left === right;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  const contains =
    shorter >= 6 && longer > 0 && shorter / longer >= 0.6 &&
    (left.includes(right) || right.includes(left));

  const expectedWords = left.split(" ").filter(Boolean);
  const actualWords = new Set(right.split(" ").filter(Boolean));
  let overlap = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) overlap += 1;
  }
  const wordsMatch =
    expectedWords.length >= 2 &&
    overlap >= 2 &&
    overlap / expectedWords.length >= 0.75;

  // A single-word title has no overlap signal, so it must match exactly.
  if (expectedWords.length === 1 ? !exact : !(exact || contains || wordsMatch)) {
    return false;
  }

  const expectedArtist = normalizeForMatch(wanted.artist || "");
  const actualArtist = normalizeForMatch(candidate.artist || "");
  if (expectedArtist && actualArtist && expectedArtist !== actualArtist) {
    const sharesToken = expectedArtist
      .split(" ")
      .some((part) => part.length >= 3 && actualArtist.includes(part));
    if (!sharesToken) return false;
  }

  if (wanted.duration && candidate.duration) {
    if (Math.abs(wanted.duration - candidate.duration) > 12) return false;
  }

  return true;
}

function titleMatchScore(expectedTitle: string, actualTitle: string): number {
  const expected = normalizeForMatch(expectedTitle);
  const actual = normalizeForMatch(actualTitle);
  if (!expected || !actual) return 0;
  if (expected === actual) return 5;
  if (actual.includes(expected) || expected.includes(actual)) return 3;
  const expectedWords = new Set(expected.split(" "));
  const actualWords = new Set(actual.split(" "));
  let overlap = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) overlap += 1;
  }
  return overlap >= Math.min(2, expectedWords.size) ? 2 : 0;
}

function authorMatchScore(
  expectedAuthor?: string,
  actualAuthor?: string,
): number {
  const expected = normalizeForMatch(expectedAuthor);
  const actual = normalizeForMatch(actualAuthor);
  if (!expected || !actual) return 0;
  if (expected === actual) return 3;
  if (expected.split(" ").some((part) => part && actual.includes(part)))
    return 1;
  return 0;
}

function extractJioSaavnAudioUrl(payload: unknown): string | null {
  const records = getJioSaavnRecords(payload);

  for (const record of records) {
    const downloadCandidates = [
      record.downloadUrl,
      record.download_url,
      record.downloadLinks,
      toRecord(record.more_info).download_url,
      toRecord(record.more_info).downloadUrl,
    ].find((value) => Array.isArray(value));

    if (Array.isArray(downloadCandidates)) {
      const best = [...downloadCandidates]
        .map((entry) => toRecord(entry))
        .sort(
          (a, b) =>
            qualityScore(b.quality || b.bitrate || b.kbps) -
            qualityScore(a.quality || a.bitrate || a.kbps),
        )
        .map((entry) =>
          pickArrayString(entry, [
            "url",
            "link",
            "downloadUrl",
            "download_url",
          ]),
        )
        .find(Boolean);
      if (best) return best;
    }

    const directUrl = pickArrayString(record, [
      "media_url",
      "mediaUrl",
      "url",
      "vlink",
      "preview_url",
    ]);
    if (directUrl && /^https?:\/\//i.test(directUrl)) return directUrl;
  }

  return null;
}

function normalizeJioSaavnPayload(
  payload: unknown,
): Record<string, unknown> | null {
  const records = getJioSaavnRecords(payload);
  const root =
    records.find(
      (record) =>
        Array.isArray(record.downloadUrl) ||
        Array.isArray(record.download_url) ||
        Boolean(
          pickArrayString(record, [
            "name",
            "title",
            "song",
            "primaryArtists",
            "primary_artists",
          ]),
        ),
    ) || toRecord(payload);
  const moreInfo = toRecord(root.more_info);
  const audioStream = extractJioSaavnAudioUrl(payload);
  if (!audioStream) return null;

  const pickFirstString = (keys: string[]): string | undefined => {
    for (const record of [root, moreInfo, ...records]) {
      const value = pickArrayString(record, keys);
      if (value) return value;
    }
    return undefined;
  };

  const pickFirstArtist = (): string | undefined => {
    for (const record of [root, moreInfo, ...records]) {
      const value = pickJioSaavnArtistNames(record);
      if (value) return value;
    }
    return undefined;
  };

  const image =
    [root, moreInfo, ...records]
      .map(
        (record) =>
          pickJioSaavnImage(record.image) ||
          pickArrayString(record, ["thumbnailUrl", "thumbnail"]),
      )
      .find(Boolean) || undefined;

  return {
    id:
      pickFirstString(["id", "songid", "identifier", "url"]) ||
      root.id ||
      root.songid ||
      root.url,
    title:
      pickFirstString(["song", "title", "name", "label"]) ||
      undefined,
    author: pickFirstArtist(),
    lengthSeconds: toNumber(root.duration) ?? toNumber(moreInfo.duration),
    thumbnailUrl: image,
    url:
      pickFirstString(["url", "perma_url", "permaUrl", "permalink"]) ||
      undefined,
    audioUrl: buildDirectProxyAudioUrl(audioStream),
    source: "jiosaavn",
  };
}

async function fetchJioSaavnFromEndpoints(
  endpoints: string[],
): Promise<Record<string, unknown> | null> {
  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, undefined, 12000);
      const normalized = normalizeJioSaavnPayload(payload);
      if (normalized?.audioUrl) return normalized;
    } catch {
      continue;
    }
  }
  return null;
}

function buildJioSaavnSongEndpoints(
  id: string,
  apiBase: string,
  urlHint?: string,
): string[] {
  const candidates = new Set<string>();
  const addId = (value?: string) => {
    if (!value) return;
    buildProviderUrlCandidates(apiBase, [
      `/api/songs/${encodeURIComponent(value)}`,
      `/songs/${encodeURIComponent(value)}`,
    ]).forEach((candidate) => candidates.add(candidate));
    buildProviderUrlCandidates(apiBase, ["/api/songs", "/songs"], {
      ids: value,
    }).forEach((candidate) => candidates.add(candidate));
  };
  const addLink = (value?: string) => {
    if (!value) return;
    buildProviderUrlCandidates(apiBase, ["/api/songs", "/songs"], {
      link: value,
    }).forEach((candidate) => candidates.add(candidate));
  };

  addId(id);

  if (urlHint) {
    addLink(urlHint);
    try {
      const parsed = new URL(urlHint);
      const token = parsed.pathname.split("/").filter(Boolean).pop();
      addId(token);
    } catch {
      addId(urlHint);
    }
  }

  return [...candidates];
}

function extractSearchCandidates(
  payload: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => toRecord(entry))
      .filter((entry) => Object.keys(entry).length);
  }

  const root = toRecord(payload);
  const nested = [
    root.results,
    toRecord(root.data).results,
    toRecord(root.data).songs,
    toRecord(toRecord(root.data).songs).results,
  ];

  for (const value of nested) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => toRecord(entry))
        .filter((entry) => Object.keys(entry).length);
    }
  }

  return [];
}

function durationMatchScore(
  expectedSeconds: number | undefined,
  actualSeconds: number | undefined,
): number {
  if (expectedSeconds == null || actualSeconds == null) return 0;
  const delta = Math.abs(expectedSeconds - actualSeconds);
  if (delta <= 3) return 2;
  if (delta >= 15) return 0;
  return 1;
}

async function findYouTubeMatchForTrack(
  title: string,
  artist: string,
  duration?: number,
): Promise<string | null> {
  const query = [title, artist].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const [pipedInstance] = await getPipedInstances();
  const endpoints = [
    pipedInstance
      ? `${pipedInstance}/search?q=${encodeURIComponent(query)}&filter=songs`
      : "",
    `https://api.ytify.workers.dev/search?q=${encodeURIComponent(query)}&filter=songs`,
  ].filter(Boolean);

  for (const endpoint of endpoints) {
    try {
      const payload = toRecord(
        await fetchJson(endpoint, undefined, 9000),
      );
      const candidates = toArray(toRecord(payload).items)
        .map(toRecord)
        .map((item) => ({
          title: typeof item.title === "string" ? item.title : "",
          author:
            typeof item.uploaderName === "string" ? item.uploaderName : "",
          duration: toNumber(item.duration),
          id:
            (typeof item.videoId === "string" && item.videoId) ||
            extractYouTubeVideoId(
              typeof item.url === "string" ? item.url : "",
            ),
        }))
        .filter((candidate) => candidate.id)
        .filter((candidate) =>
          isVerifiedMetadataMatch(
            { title, artist, duration },
            {
              title: candidate.title,
              artist: candidate.author,
              duration: candidate.duration,
            },
          ),
        )
        .map((candidate) => ({
          id: candidate.id,
          score:
            titleMatchScore(title, candidate.title) * 2 +
            titleMatchScore(artist, candidate.author) +
            durationMatchScore(duration, candidate.duration),
        }))
        .sort((a, b) => b.score - a.score);

      if (candidates[0]) return candidates[0].id;
    } catch {
      continue;
    }
  }

  return null;
}

type SoundCloudCandidate = { url: string; seconds: number; score: number };

/**
 * Search queries to try against SoundCloud, most-likely first.
 *
 * SoundCloud uploads are titled "Artist - Track", while the metadata we get
 * from Spotify/Deezer/iTunes is `title` + a possibly multi-artist `artist`
 * ("Peida Nakardam" / "Behzad Leito, Anita"). Querying the title first never
 * surfaced the real upload for those; putting the artist first (and using
 * just the primary artist) is what finds "Behzad Leito - Peida Nakardam
 * (Ft Anita)". The old title-first query is kept as a fallback, plus the
 * bare title for uploads that omit the artist entirely.
 */
function buildSoundCloudQueries(title: string, artist: string): string[] {
  const trimmedTitle = String(title || "").trim();
  const trimmedArtist = String(artist || "").trim();
  const primary = primaryArtist(trimmedArtist);
  const variants: string[] = [];
  const push = (value: string) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized && !variants.includes(normalized)) variants.push(normalized);
  };

  if (trimmedArtist && trimmedTitle) push(`${trimmedArtist} ${trimmedTitle}`);
  if (primary && primary !== trimmedArtist && trimmedTitle) {
    push(`${primary} ${trimmedTitle}`);
  }
  if (trimmedTitle && trimmedArtist) push(`${trimmedTitle} ${trimmedArtist}`);
  if (trimmedTitle) push(trimmedTitle);

  return variants;
}

/** One SoundCloud search: search, then apply the shared identity gate. */
async function findSoundCloudCandidatesForQuery(
  query: string,
  title: string,
  artist: string,
  duration?: number,
): Promise<SoundCloudCandidate[]> {
  const endpoints = buildProviderUrlCandidates(
    "https://beatseek.io/api",
    ["/search", "/api/search"],
    { query, platform: "soundcloud", type: "tracks", limit: 8 },
  );

  for (const endpoint of endpoints) {
    try {
      const payload = toRecord(await fetchJson(endpoint, undefined, 9000));
      // beatseek answers with `results`; older/alternate shapes use `tracks`.
      const rawItems = toArray(payload.results).length
        ? toArray(payload.results)
        : toArray(payload.tracks);

      return rawItems
        .map(toRecord)
        .map((item) => {
          const candidateTitle =
            typeof item.title === "string" ? item.title : "";
          const candidateAuthor =
            typeof item.artist === "string" && item.artist.trim()
              ? item.artist.trim()
              : typeof toRecord(item.user).username === "string"
                ? toRecord(item.user).username
                : "";
          const candidateUrl =
            typeof item.url === "string"
              ? item.url
              : typeof item.permalink_url === "string"
                ? item.permalink_url
                : "";
          const titleScore = titleMatchScore(title, candidateTitle);
          const rawDuration = toNumber(item.duration);
          return {
            title: candidateTitle,
            author: candidateAuthor,
            url: candidateUrl,
            titleScore,
            duration:
              rawDuration == null
                ? undefined
                : rawDuration > 1000
                  ? Math.round(rawDuration / 1000)
                  : Math.round(rawDuration),
            authorScore: authorMatchScore(artist, candidateAuthor),
          };
        })
        .filter((candidate) => candidate.url && candidate.titleScore >= 2)
        // Same identity gate as the JioSaavn/YouTube matchers: the track must
        // BE this song, not merely score high enough.
        //
        // SoundCloud uploads put the artist in the TITLE far more often than
        // in the uploader field ("Michael Jackson - Billie Jean" posted by
        // some fan account), so accept either location — otherwise every
        // full-length upload gets rejected for an uploader mismatch.
        .filter((candidate) =>
          isVerifiedMetadataMatch(
            { title, artist, duration },
            {
              title: candidate.title,
              artist:
                artistMatchIsInTitle(artist, candidate.title)
                  ? artist
                  : candidate.author,
              duration: candidate.duration,
            },
          ),
        )
        .map((candidate) => ({
          url: candidate.url,
          seconds: candidate.duration ?? 0,
          score: candidate.titleScore * 2 + candidate.authorScore,
        }));
    } catch {
      continue;
    }
  }

  return [];
}

async function findSoundCloudMatchForTrack(
  title: string,
  artist: string,
  duration?: number,
): Promise<string | null> {
  const queries = buildSoundCloudQueries(title, artist);
  if (!queries.length) return null;

  const collected: SoundCloudCandidate[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    const found = await findSoundCloudCandidatesForQuery(
      query,
      title,
      artist,
      duration,
    );
    for (const candidate of found) {
      if (seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);
      collected.push(candidate);
    }
    // Stop as soon as a query yielded a verified FULL-length track: further
    // queries only add latency, and this is already the best answer we can
    // give (the extra variants exist only to rescue tracks the first query
    // could not find).
    if (found.some((candidate) => candidate.seconds > 32)) break;
  }

  if (!collected.length) return null;

  // Never hand back a 30s preview clip when a full version verified.
  const hasFullVersion = collected.some((candidate) => candidate.seconds > 32);
  const usable = hasFullVersion
    ? collected.filter((candidate) => candidate.seconds > 32)
    : collected;
  usable.sort((a, b) => b.score - a.score);

  return usable[0]?.url ?? null;
}


/**
 * Resolve `promise`, or `fallback` if it has not settled within `ms`.
 *
 * Provider lookups run against third-party endpoints that can stall for
 * minutes (a dead mirror, a rate-limit black hole). Without a deadline a
 * single slow provider blocks the play button indefinitely, so every stage
 * of the resolution chain gets a budget.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    promise.then(finish, () => finish(fallback));
  });
}

async function getEndpointsSafe() {
  try {
    return await getProviderEndpoints();
  } catch {
    return getCachedProviderEndpointsSnapshot();
  }
}

async function findJioSaavnMatch(
  title: string,
  artist?: string,
): Promise<{ id: string; url?: string } | null> {
  const query = [title, artist].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const providerEndpoints = await getEndpointsSafe();
  const endpoints = [
    ...buildProviderUrlCandidates(
      providerEndpoints.providers.jiosaavn.apiBase,
      ["/api/search", "/search"],
      { query },
    ),
    ...buildProviderUrlCandidates(
      providerEndpoints.providers.jiosaavn.fallbackSearchBase,
      ["/search"],
      { query },
    ),
  ];

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, undefined, 12000);
      const candidates = extractSearchCandidates(payload)
        .map((entry) => ({
          entry,
          title: pickArrayString(entry, ["title", "song", "name"]) || "",
          author:
            pickArrayString(entry, [
              "description",
              "primary_artists",
              "primaryArtists",
              "singers",
              "artist",
            ]) || "",
          id: pickArrayString(entry, ["id", "identifier"]) || "",
          url: pickArrayString(entry, ["url", "permalink_url"]),
        }))
        .map((candidate) => ({
          ...candidate,
          score:
            titleMatchScore(title, candidate.title) +
            authorMatchScore(artist, candidate.author),
        }))
        .filter((candidate) => candidate.id)
        .filter((candidate) =>
          isVerifiedMetadataMatch(
            { title, artist },
            { title: candidate.title, artist: candidate.author },
          ),
        )
        .sort((a, b) => b.score - a.score);

      if (candidates[0]) {
        return {
          id: candidates[0].id,
          url: candidates[0].url,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

let soundCloudClientId: string | null = null;

async function getSoundCloudClientId(reset = false): Promise<string> {
  if (soundCloudClientId && !reset) return soundCloudClientId;

  const providerEndpoints = await getProviderEndpoints();
  const soundcloud = providerEndpoints.providers.soundcloud;

  try {
    // Try to get client ID from a known working endpoint first
    const oembedUrls = buildProviderUrlCandidates(
      soundcloud.oembedBase,
      ["/oembed"],
      { url: `${soundcloud.origin}/lil-durk/back-again` },
    );
    for (const apiUrl of oembedUrls) {
      try {
        const oembedResponse = await fetchTextWithHeaders(
          apiUrl,
          {
            "User-Agent": USER_AGENT,
            Referer: `${soundcloud.origin}/`,
            Origin: soundcloud.origin,
          },
          12000,
        );

        // Try to extract client ID from oembed response
        const clientIdMatch = oembedResponse.match(
          /client_id["\s:]+([a-zA-Z0-9]+)/,
        );
        if (clientIdMatch?.[1]) {
          soundCloudClientId = clientIdMatch[1];
          return soundCloudClientId;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Continue with other methods if oembed fails
  }

  try {
    const desktopHtml = await fetchTextWithHeaders(
      soundcloud.origin,
      {
        "User-Agent": USER_AGENT,
        Referer: `${soundcloud.origin}/`,
        Origin: soundcloud.origin,
      },
      12000,
    );

    const scriptUrls = desktopHtml.match(/https?:\/\/[^\s"]+\.js/g) || [];
    for (const scriptUrl of scriptUrls) {
      try {
        const script = await fetchTextWithHeaders(
          scriptUrl,
          { "User-Agent": USER_AGENT, Referer: `${soundcloud.origin}/` },
          12000,
        );
        const match = script.match(/[{,]client_id:"(\w+)"/);
        if (match?.[1]) {
          soundCloudClientId = match[1];
          return soundCloudClientId;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Continue with mobile method if desktop fails
  }

  try {
    const mobileHtml = await fetchTextWithHeaders(
      `${soundcloud.mobileOrigin}/`,
      {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/99.0.4844.47 Mobile/15E148 Safari/604.1",
      },
      12000,
    );
    const mobileMatch = mobileHtml.match(/"clientId":"(\w+?)"/);
    if (mobileMatch?.[1]) {
      soundCloudClientId = mobileMatch[1];
      return soundCloudClientId;
    }
  } catch {
    // Continue with fallback
  }

  // Fallback to a commonly working client ID
  const fallbackClientId = "iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX";
  soundCloudClientId = fallbackClientId;
  return soundCloudClientId;
}

async function fetchSoundCloudJson(url: string): Promise<unknown> {
  const clientId = await getSoundCloudClientId();
  const requestUrl = `${url}${
    url.includes("?") ? "&" : "?"
  }client_id=${clientId}`;

  try {
    return await fetchJson(requestUrl, undefined, 12000);
  } catch (error) {
    const fallbackClientId = await getSoundCloudClientId(true);
    const fallbackUrl = `${url}${
      url.includes("?") ? "&" : "?"
    }client_id=${fallbackClientId}`;
    return fetchJson(fallbackUrl, undefined, 12000);
  }
}

function normalizeSoundCloudUrlHint(urlHint?: string): string | undefined {
  if (!urlHint) return undefined;

  try {
    const parsed = new URL(urlHint);
    if (
      parsed.hostname === "w.soundcloud.com" &&
      parsed.pathname === "/player/"
    ) {
      const embeddedUrl = parsed.searchParams.get("url");
      if (embeddedUrl) return embeddedUrl;
    }
    return parsed.toString();
  } catch {
    return urlHint;
  }
}

function extractSoundCloudTrackId(value?: string): string | undefined {
  if (!value) return undefined;

  const trackRefMatch = value.match(/soundcloud:tracks:(\d+)/i);
  if (trackRefMatch?.[1]) return trackRefMatch[1];

  const apiTrackMatch = value.match(/api\.soundcloud\.com\/tracks\/(\d+)/i);
  if (apiTrackMatch?.[1]) return apiTrackMatch[1];

  const apiV2TrackMatch = value.match(
    /api-v2\.soundcloud\.com\/tracks\/(\d+)/i,
  );
  if (apiV2TrackMatch?.[1]) return apiV2TrackMatch[1];

  return undefined;
}

function soundCloudTranscodingScore(entry: Record<string, any>): number {
  const format = toRecord(entry.format);
  const protocol = String(format.protocol || "").toLowerCase();
  const mimeType = String(format.mime_type || "").toLowerCase();
  let score = 0;

  if (protocol === "progressive") score += 100;
  if (protocol === "ctr-encrypted-hls") score += 90;
  if (protocol === "cbc-encrypted-hls") score += 80;
  if (protocol.includes("encrypted")) score += 20;
  if (protocol === "hls") score += 10;
  if (!entry.is_legacy_transcoding) score += 5;
  if (mimeType.includes("audio/mp4")) score += 2;
  if (String(entry.quality || "").toLowerCase() === "sq") score += 1;

  return score;
}

async function fetchSoundCloudStreamPayload(
  transcodings: Record<string, any>[],
  trackAuthorization: string | null,
): Promise<{
  streamPayload: Record<string, any>;
  transcoding: Record<string, any>;
}> {
  const candidates = [...transcodings].sort(
    (a, b) => soundCloudTranscodingScore(b) - soundCloudTranscodingScore(a),
  );
  const errors: string[] = [];

  for (const candidate of candidates) {
    const transcodingUrl =
      typeof candidate.url === "string" ? candidate.url : undefined;
    if (!transcodingUrl) continue;

    try {
      const requestUrl = new URL(transcodingUrl);
      if (trackAuthorization) {
        requestUrl.searchParams.set("track_authorization", trackAuthorization);
      }

      const streamPayload = toRecord(
        await fetchSoundCloudJson(requestUrl.toString()),
      );
      if (typeof streamPayload.url === "string" && streamPayload.url) {
        return { streamPayload, transcoding: candidate };
      }

      errors.push(
        `${
          toRecord(candidate.format).protocol || "unknown"
        }: missing stream url`,
      );
    } catch (error) {
      errors.push(
        `${toRecord(candidate.format).protocol || "unknown"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new Error(
    `SoundCloud stream URL lookup failed${
      errors.length ? ` (${errors.join(" | ")})` : ""
    }`,
  );
}

async function fetchSoundCloudDetails(
  id: string,
  urlHint?: string,
): Promise<Record<string, unknown>> {
  const providerEndpoints = await getProviderEndpoints();
  const soundcloud = providerEndpoints.providers.soundcloud;
  const normalizedUrlHint = normalizeSoundCloudUrlHint(urlHint);
  const hintedTrackId = extractSoundCloudTrackId(normalizedUrlHint);
  const resolvedTrackId = hintedTrackId || id;
  const resolveTarget =
    normalizedUrlHint || `${soundcloud.apiV2Base}/tracks/${resolvedTrackId}`;

  // #region debug-point A:soundcloud-resolve-start
  reportDebugEvent(
    `pre-${Date.now()}`,
    "A",
    "app/api/video/route.ts:fetchSoundCloudDetails:start",
    "[DEBUG] resolving SoundCloud track",
    {
      id,
      urlHint: normalizedUrlHint || null,
      hintedTrackId: hintedTrackId || null,
      resolveTarget,
    },
  );
  // #endregion

  const payload = normalizedUrlHint
    ? await fetchSoundCloudJson(
        buildProviderUrlCandidates(soundcloud.apiV2Base, ["/resolve"], {
          url: resolveTarget,
        })[0] || "",
      )
    : await fetchSoundCloudJson(
        buildProviderUrlCandidates(soundcloud.apiV2Base, [
          `/tracks/${encodeURIComponent(resolvedTrackId)}`,
        ])[0] || "",
      );

  const track = toRecord(payload);
  if (!track.id) {
    throw new Error("SoundCloud track could not be resolved");
  }

  // #region debug-point B:soundcloud-track-resolved
  reportDebugEvent(
    `pre-${Date.now()}`,
    "B",
    "app/api/video/route.ts:fetchSoundCloudDetails:resolved",
    "[DEBUG] SoundCloud track resolved",
    {
      requestedId: id,
      resolvedId: track.id,
      permalinkUrl:
        typeof track.permalink_url === "string" ? track.permalink_url : null,
      mediaPresent: Boolean(toRecord(track.media).transcodings),
      duration: toNumber(track.duration) ?? null,
    },
  );
  // #endregion

  const transcodings = toArray(toRecord(track.media).transcodings).map(
    (entry) => toRecord(entry),
  );
  if (!transcodings.length) {
    throw new Error("SoundCloud track did not expose a playable transcoding");
  }

  const trackAuthorization =
    typeof track.track_authorization === "string"
      ? track.track_authorization
      : null;

  const { streamPayload, transcoding: bestTranscoding } =
    await fetchSoundCloudStreamPayload(transcodings, trackAuthorization);
  const transcodingUrl =
    typeof bestTranscoding.url === "string" ? bestTranscoding.url : null;
  const streamUrl =
    typeof streamPayload.url === "string" ? streamPayload.url : null;
  if (!streamUrl) {
    throw new Error("SoundCloud stream URL lookup failed");
  }

  // #region debug-point C:soundcloud-transcoding-picked
  reportDebugEvent(
    `pre-${Date.now()}`,
    "C",
    "app/api/video/route.ts:fetchSoundCloudDetails:transcoding",
    "[DEBUG] SoundCloud transcoding selected",
    {
      requestedId: id,
      transcodingUrl,
      protocol:
        typeof toRecord(bestTranscoding?.format).protocol === "string"
          ? toRecord(bestTranscoding?.format).protocol
          : null,
      mimeType:
        typeof toRecord(bestTranscoding?.format).mime_type === "string"
          ? toRecord(bestTranscoding?.format).mime_type
          : null,
      transcodingCount: transcodings.length,
    },
  );
  // #endregion

  // #region debug-point D:soundcloud-stream-resolved
  reportDebugEvent(
    `pre-${Date.now()}`,
    "D",
    "app/api/video/route.ts:fetchSoundCloudDetails:stream",
    "[DEBUG] SoundCloud stream URL resolved",
    {
      requestedId: id,
      hasStreamUrl: Boolean(streamUrl),
      streamHost: (() => {
        try {
          return new URL(streamUrl).hostname;
        } catch {
          return null;
        }
      })(),
      streamPath: (() => {
        try {
          return new URL(streamUrl).pathname;
        } catch {
          return null;
        }
      })(),
      isCbcsOrCenc: isSoundCloudEncryptedStreamUrl(streamUrl),
      hasLicenseAuthToken: Boolean(streamPayload.licenseAuthToken),
      payloadKeys:
        streamPayload && typeof streamPayload === "object"
          ? Object.keys(streamPayload).slice(0, 12)
          : [],
    },
  );
  // #endregion

  const isEncrypted = isSoundCloudEncryptedStreamUrl(streamUrl);
  const licenseAuthToken =
    typeof streamPayload.licenseAuthToken === "string"
      ? streamPayload.licenseAuthToken
      : null;
  const widgetTrackUrl =
    typeof track.permalink_url === "string" && track.permalink_url.trim()
      ? track.permalink_url
      : normalizedUrlHint ||
        `${soundcloud.apiBase}/tracks/${encodeURIComponent(String(track.id))}`;

  if (isEncrypted) {
    if (!licenseAuthToken) {
      throw new Error(
        "SoundCloud encrypted stream did not include a licenseAuthToken",
      );
    }

    const rawLicenseUrl = buildSoundCloudWidevineLicenseUrl(
      soundcloud.licenseBase,
      licenseAuthToken,
    );
    const proxiedLicenseUrl = `/api/license-proxy?url=${encodeURIComponent(
      rawLicenseUrl,
    )}`;

    return {
      id: track.id,
      title: track.title,
      author: toRecord(track.user).username,
      lengthSeconds: Math.floor((toNumber(track.duration) ?? 0) / 1000),
      thumbnailUrl: track.artwork_url || toRecord(track.user).avatar_url,
      url: widgetTrackUrl,
      audioType: "soundcloud-drm",
      audioUrl: streamUrl,
      drmLicenseUrl: proxiedLicenseUrl,
      drmScheme: "com.widevine.alpha",
      drmProvider: "soundcloud",
      source: "soundcloud",
      drmHeaders: {
        "Content-Type": "application/octet-stream",
      },
      playbackStrategy: "widget",
    };
  }

  return {
    id: track.id,
    title: track.title,
    author: toRecord(track.user).username,
    lengthSeconds: Math.floor((toNumber(track.duration) ?? 0) / 1000),
    thumbnailUrl: track.artwork_url || toRecord(track.user).avatar_url,
    url: widgetTrackUrl,
    source: "soundcloud",
    audioUrl: buildDirectProxyAudioUrl(streamUrl),
    playbackStrategy: "audio",
  };
}

async function fetchJsonViaPowerShell(
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const escapedUrl = url.replace(/'/g, "''");
  const escapedUserAgent = USER_AGENT.replace(/'/g, "''");
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$headers = @{ 'User-Agent' = '${escapedUserAgent}'; 'Accept' = 'application/json, text/plain;q=0.9, */*;q=0.8'; 'Accept-Language' = 'en-US,en;q=0.9'; 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' }`,
    `$response = Invoke-RestMethod -Uri '${escapedUrl}' -Headers $headers -TimeoutSec ${Math.max(
      1,
      Math.ceil(timeoutMs / 1000),
    )}`,
    "$response | ConvertTo-Json -Depth 100 -Compress",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: timeoutMs + 3000,
      maxBuffer: 1024 * 1024 * 5,
    },
  );

  return parseJsonText(
    stdout,
    "Invalid JSON response from PowerShell fallback",
  );
}

async function fetchTextViaPowerShell(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const escapedUrl = url.replace(/'/g, "''");
  const headerEntries = Object.entries(headers).map(
    ([key, value]) =>
      `'${key.replace(/'/g, "''")}' = '${value.replace(/'/g, "''")}'`,
  );
  const headerScript = headerEntries.length
    ? `@{ ${headerEntries.join("; ")} }`
    : "@{}";
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$headers = ${headerScript}`,
    `$response = Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -Headers $headers -TimeoutSec ${Math.max(
      1,
      Math.ceil(timeoutMs / 1000),
    )}`,
    "$response.Content",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: timeoutMs + 3000,
      maxBuffer: 1024 * 1024 * 5,
    },
  );

  return stdout;
}

async function fetchJson(
  url: string,
  signal?: AbortSignal,
  timeoutMs = INVIDIOUS_TIMEOUT_MS,
): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      cache: "no-store",
      signal: withTimeout(signal, timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
      );
    }

    return parseJsonText(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldTryPowerShell =
      process.platform === "win32" &&
      (/fetch failed|ECONNRESET|aborted|UND_ERR_CONNECT_TIMEOUT/i.test(
        message,
      ) ||
        message.includes("This operation was aborted"));

    if (!shouldTryPowerShell) {
      throw error;
    }

    return fetchJsonViaPowerShell(url, timeoutMs);
  }
}

function pickBestStreamUrl(
  candidates: unknown[],
  base?: string,
): string | null {
  const items = Array.isArray(candidates) ? candidates : [];

  const audioCandidates = items
    .filter((f: any) => typeof f?.url === "string")
    .filter((f: any) => {
      const t = typeof f?.type === "string" ? f.type : "";
      const mime = typeof f?.mimeType === "string" ? f.mimeType : "";
      return (
        isAudioMime(t) || isAudioMime(mime) || Boolean((f as any)?.audioCodec)
      );
    })
    .sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  const preferred =
    audioCandidates.find((f: any) =>
      String(f.type || f.mimeType || "").includes("mp4"),
    ) ||
    audioCandidates.find((f: any) =>
      String(f.type || f.mimeType || "").includes("opus"),
    ) ||
    audioCandidates[0];

  const p = preferred as any;
  const raw = p?.url ? String(p.url) : "";
  if (!raw) return null;
  return base ? absolutizeUrl(raw, base) : raw;
}

function buildInvidiousRelayUrl(
  streamUrl: string,
  base: string,
): string | null {
  try {
    const resolvedStreamUrl = new URL(streamUrl, base);
    const providerBaseUrl = new URL(base);

    if (!/googlevideo\.com$/i.test(resolvedStreamUrl.hostname)) {
      return null;
    }

    providerBaseUrl.pathname = resolvedStreamUrl.pathname;
    providerBaseUrl.search = resolvedStreamUrl.search;
    providerBaseUrl.hash = "";

    return providerBaseUrl.toString();
  } catch {
    return null;
  }
}

function buildPlayableAudioUrl(
  streamUrl: string | null,
  base: string,
): string | null {
  if (!streamUrl) return null;

  const resolvedStreamUrl = absolutizeUrl(streamUrl, base);
  const invidiousRelayUrl = buildInvidiousRelayUrl(resolvedStreamUrl, base);

  if (invidiousRelayUrl) {
    return invidiousRelayUrl;
  }

  return `/api/audio-proxy?url=${encodeURIComponent(resolvedStreamUrl)}`;
}

function summarizeAudioCandidates(
  candidates: unknown[],
): Record<string, unknown>[] {
  const items = Array.isArray(candidates) ? candidates : [];

  return items
    .filter((entry: any) => typeof entry?.url === "string")
    .slice(0, 5)
    .map((entry: any) => ({
      url: String(entry.url),
      type: typeof entry.type === "string" ? entry.type : null,
      mimeType: typeof entry.mimeType === "string" ? entry.mimeType : null,
      bitrate:
        typeof entry.bitrate === "number" || typeof entry.bitrate === "string"
          ? entry.bitrate
          : null,
      audioCodec:
        typeof entry.audioCodec === "string" ? entry.audioCodec : null,
    }));
}

function extractVideoIdFromUrl(value: string): string {
  const rawValue = value.trim();
  if (!rawValue) return "";

  const watchMatch = rawValue.match(/[?&]v=([^&]+)/);
  if (watchMatch?.[1]) return watchMatch[1];

  const shortMatch = rawValue.match(/youtu\.be\/([^?]+)/);
  if (shortMatch?.[1]) return shortMatch[1];

  const pathMatch = rawValue.match(/\/watch\/([^/?#]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  return "";
}

async function fetchYouTubeOEmbedMetadata(
  videoId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const providerEndpoints = await getProviderEndpoints();
    const youtube = providerEndpoints.providers.youtube;
    const payload = (await fetchJson(
      buildProviderUrlCandidates(youtube.oembedBase, ["/oembed"], {
        url: `${youtube.webBase}/watch?v=${videoId}`,
        format: "json",
      })[0] || "",
      undefined,
      8000,
    )) as Record<string, unknown>;

    const title =
      typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim()
        : "";
    if (!title) {
      return null;
    }

    return {
      id: videoId,
      title,
      author:
        typeof payload.author_name === "string" && payload.author_name.trim()
          ? payload.author_name.trim()
          : "YouTube",
      thumbnailUrl:
        typeof payload.thumbnail_url === "string" &&
        payload.thumbnail_url.trim()
          ? normalizeYouTubeThumbnailUrl({
              url: payload.thumbnail_url.trim(),
              videoId,
            })
          : normalizeYouTubeThumbnailUrl({
              url: `${youtube.imageBase}/vi/${encodeURIComponent(
                videoId,
              )}/hqdefault.jpg`,
              videoId,
            }),
      url: `${youtube.webBase}/watch?v=${encodeURIComponent(videoId)}`,
    };
  } catch {
    return null;
  }
}

function extractChannelIdFromUrl(value: string): string {
  const rawValue = value.trim().replace(/^\/+/, "");
  if (!rawValue) return "";

  const channelMatch = rawValue.match(/^channel\/([^/?#]+)/i);
  if (channelMatch?.[1]) return channelMatch[1];

  if (/^https?:\/\//i.test(rawValue)) {
    try {
      const parsed = new URL(rawValue);
      return extractChannelIdFromUrl(parsed.pathname);
    } catch {
      return "";
    }
  }

  return "";
}

function pickThumbnailUrl(
  record: Record<string, unknown>,
  base: string,
): string {
  const rawUrl =
    typeof record.url === "string"
      ? record.url
      : typeof record.videoUrl === "string"
        ? record.videoUrl
        : "";
  const videoId =
    typeof record.videoId === "string"
      ? record.videoId
      : typeof record.id === "string"
        ? record.id
        : extractYouTubeVideoId(rawUrl);
  const directThumbnail =
    typeof record.thumbnailUrl === "string"
      ? record.thumbnailUrl
      : typeof record.thumbnail === "string"
        ? record.thumbnail
        : null;

  if (directThumbnail) {
    return (
      normalizeYouTubeThumbnailUrl({
        url: absolutizeUrl(directThumbnail, base),
        videoId,
      }) || absolutizeUrl(directThumbnail, base)
    );
  }

  const thumbs = toArray(record.videoThumbnails)
    .map((entry) => toRecord(entry))
    .sort((left, right) => {
      const leftScore =
        (toNumber(left.width) ?? 0) * (toNumber(left.height) ?? 0);
      const rightScore =
        (toNumber(right.width) ?? 0) * (toNumber(right.height) ?? 0);
      return rightScore - leftScore;
    });

  const thumbnailUrl = absolutizeUrl(String(thumbs[0]?.url || ""), base);
  return (
    normalizeYouTubeThumbnailUrl({
      url: thumbnailUrl,
      videoId,
    }) || thumbnailUrl
  );
}

function pickArtistImageUrl(
  record: Record<string, unknown>,
  base: string,
): string | undefined {
  const directImage =
    typeof record.uploaderAvatar === "string"
      ? record.uploaderAvatar
      : typeof record.authorImage === "string"
        ? record.authorImage
        : null;

  if (directImage) {
    return absolutizeUrl(directImage, base);
  }

  const thumbs = toArray(record.authorThumbnails)
    .map((entry) => toRecord(entry))
    .sort((left, right) => {
      const leftScore =
        (toNumber(left.width) ?? 0) * (toNumber(left.height) ?? 0);
      const rightScore =
        (toNumber(right.width) ?? 0) * (toNumber(right.height) ?? 0);
      return rightScore - leftScore;
    });

  const image = String(thumbs[0]?.url || "");
  return image ? absolutizeUrl(image, base) : undefined;
}

function normalizeRelatedSongs(
  value: unknown,
  base: string,
  source: string,
): Array<Record<string, unknown>> {
  const items = toArray(value);
  const seen = new Set<string>();

  return items
    .map((entry) => toRecord(entry))
    .map((record) => {
      const rawUrl =
        typeof record.url === "string"
          ? record.url
          : typeof record.videoUrl === "string"
            ? record.videoUrl
            : "";
      const id =
        typeof record.videoId === "string"
          ? record.videoId
          : typeof record.id === "string"
            ? record.id
            : extractVideoIdFromUrl(rawUrl);
      const title =
        typeof record.title === "string"
          ? record.title
          : typeof record.name === "string"
            ? record.name
            : "";

      if (!id || !title || seen.has(id)) {
        return null;
      }

      seen.add(id);

      return {
        id,
        title,
        artist:
          typeof record.author === "string"
            ? record.author
            : typeof record.uploaderName === "string"
              ? record.uploaderName
              : typeof record.uploader === "string"
                ? record.uploader
                : "Unknown Artist",
        artistId:
          typeof record.authorId === "string"
            ? record.authorId
            : extractChannelIdFromUrl(
                typeof record.uploaderUrl === "string"
                  ? record.uploaderUrl
                  : "",
              ) || undefined,
        artistImage: pickArtistImageUrl(record, base),
        coverUrl: pickThumbnailUrl(record, base),
        duration:
          toNumber(record.lengthSeconds) ??
          toNumber(record.duration) ??
          toNumber(record.durationSeconds),
        uploaded:
          typeof record.uploadedDate === "string"
            ? record.uploadedDate
            : typeof record.publishedText === "string"
              ? record.publishedText
              : typeof record.uploaded === "string"
                ? record.uploaded
                : undefined,
        source,
        url: rawUrl ? absolutizeUrl(rawUrl, base) : `/watch?v=${id}`,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function normalizeVideoPayload(
  data: unknown,
  base: string,
  source = "youtube",
): Record<string, unknown> | null {
  const record = toRecord(data);
  const adaptiveFormats = toArray(record.adaptiveFormats);
  const audioStreams = toArray(record.audioStreams);
  const formatStreams = toArray(record.formatStreams);
  const directAudioUrl =
    typeof record.audioUrl === "string" ? record.audioUrl : null;

  const preferredUrl =
    directAudioUrl ||
    pickBestStreamUrl([...adaptiveFormats, ...audioStreams], base) ||
    pickBestStreamUrl(formatStreams, base);
  const videoId =
    typeof record.videoId === "string"
      ? record.videoId
      : typeof record.id === "string"
        ? record.id
        : extractYouTubeVideoId(
            typeof record.url === "string" ? record.url : "",
          );

  const thumbs = toArray(record.videoThumbnails).map((entry) =>
    toRecord(entry),
  );
  const maxThumb = thumbs.find((t) => t.quality === "maxres")?.url;
  const anyThumb =
    typeof record.thumbnailUrl === "string"
      ? record.thumbnailUrl
      : typeof record.thumbnail === "string"
        ? record.thumbnail
        : thumbs[0]?.url;

  const audioUrl = buildPlayableAudioUrl(preferredUrl, base);

  if (
    !audioUrl &&
    !record.title &&
    !record.name &&
    !record.videoId &&
    !record.id
  ) {
    return null;
  }

  return {
    id: record.videoId || record.id,
    title: record.title || record.name,
    author: record.author || record.uploader || record.uploaderName,
    lengthSeconds:
      toNumber(record.lengthSeconds) ??
      toNumber(record.duration) ??
      toNumber(record.durationSeconds),
    adaptiveFormats:
      adaptiveFormats.length > 0
        ? adaptiveFormats
        : audioStreams.length > 0
          ? audioStreams
          : undefined,
    audioUrl,
    thumbnailUrl:
      normalizeYouTubeThumbnailUrl({
        url: absolutizeUrl(String(maxThumb || anyThumb || ""), base),
        videoId,
      }) || absolutizeUrl(String(maxThumb || anyThumb || ""), base),
    relatedSongs: normalizeRelatedSongs(
      record.recommendedVideos || record.relatedStreams,
      base,
      source,
    ),
  };
}

async function fetchVideoFromInvidious(
  instance: string,
  videoId: string,
  source?: string,
  signal?: AbortSignal,
) {
  const base = instance.replace(/\/+$/, "");
  const data = await fetchJson(
    `${base}/api/v1/videos/${videoId}`,
    signal,
    INVIDIOUS_TIMEOUT_MS,
  );
  const normalized = normalizeVideoPayload(data, base, source);
  if (!normalized?.audioUrl) {
    throw new Error(
      "Invidious response did not include a playable audio stream",
    );
  }
  return normalized;
}

async function fetchVideoFromPiped(
  instance: string,
  videoId: string,
  source?: string,
  signal?: AbortSignal,
) {
  const base = instance.replace(/\/+$/, "");
  const data = await fetchJson(
    `${base}/streams/${videoId}`,
    signal,
    PIPED_TIMEOUT_MS,
  );
  const normalized = normalizeVideoPayload(data, base, source);
  if (!normalized?.audioUrl) {
    throw new Error("Piped response did not include a playable audio stream");
  }
  return normalized;
}

async function fetchVideoDetails(
  videoId: string,
  runId: string,
  source?: string,
  options?: {
    title?: string;
    artist?: string;
    urlHint?: string;
    providerHint?: string;
    duration?: number;
  },
): Promise<Record<string, unknown>> {
  if (source === "youtubemusic") {
    const providerEndpoints = await getProviderEndpoints();
    const matchedJioSaavnSong = await findJioSaavnMatch(
      options?.title || "",
      options?.artist,
    );

    if (matchedJioSaavnSong?.id) {
      const jioSaavnPayload = await fetchJioSaavnFromEndpoints(
        buildJioSaavnSongEndpoints(
          matchedJioSaavnSong.id,
          providerEndpoints.providers.jiosaavn.apiBase,
          matchedJioSaavnSong.url,
        ),
      );
      if (jioSaavnPayload?.audioUrl) {
        return jioSaavnPayload;
      }
    }
  }

  // The videoId should be the only thing needed for youtube/youtubemusic
  if (source === "youtube" || source === "youtubemusic" || !source) {
    const [invidiousInstances, pipedInstances] = await Promise.all([
      getInvidiousInstances(),
      getPipedInstances(),
    ]);
    const preferredHints = parseYouTubeProviderHints(
      options?.providerHint,
      source,
    );
    const providers = prioritizeVideoProviders(
      [
        ...invidiousInstances.map((instance) => ({
          label: `invidious:${instance}`,
          run: (signal?: AbortSignal) =>
            fetchVideoFromInvidious(instance, videoId, source, signal),
        })),
        ...pipedInstances.map((instance) => ({
          label: `piped:${instance}`,
          run: (signal?: AbortSignal) =>
            fetchVideoFromPiped(instance, videoId, source, signal),
        })),
      ],
      preferredHints,
    );

    try {
      const value = await tryVideoProvidersSequentially(
        providers,
        runId,
        source,
      );
      if (value) {
        return value;
      }
    } catch (error) {
      throw error;
    }

    throw new Error("All YouTube providers failed");
  }

  if (source === "soundcloud") {
    const hasTrackId = /^\d+$/.test(videoId);
    const hasUrlHint = Boolean(options?.urlHint);
    if (!hasTrackId && !hasUrlHint) {
      const title = options?.title || "";
      const artist = options?.artist || "";
      const soundcloudUrl = await findSoundCloudMatchForTrack(
        title,
        artist,
        options?.duration,
      );
      if (soundcloudUrl)
        return fetchSoundCloudDetails(soundcloudUrl, soundcloudUrl);
      throw new Error("No playable source found for SoundCloud track");
    }
    return fetchSoundCloudDetails(videoId, options?.urlHint);
  }

  if (
    source === "spotify" ||
    source === "deezer" ||
    source === "itunes"
  ) {
    const title = options?.title || "";
    const artist = options?.artist || "";
    if (!title) throw new Error(`${source} track metadata is missing`);

    // SoundCloud first (user preference), JioSaavn as fallback — and both are
    // started together so the wait is the SLOWER of the two, not their sum.
    const jioSaavnPromise = (async () => {
      const matchedJioSaavnSong = await findJioSaavnMatch(title, artist);
      if (!matchedJioSaavnSong?.id) return null;
      const providerEndpoints = await getEndpointsSafe();
      const jioSaavnPayload = await fetchJioSaavnFromEndpoints(
        buildJioSaavnSongEndpoints(
          matchedJioSaavnSong.id,
          providerEndpoints.providers.jiosaavn.apiBase,
          matchedJioSaavnSong.url,
        ),
      );
      return jioSaavnPayload?.audioUrl ? jioSaavnPayload : null;
    })();

    const soundCloudPromise = (async () => {
      const soundcloudUrl = await findSoundCloudMatchForTrack(
        title,
        artist,
        options?.duration,
      );
      if (!soundcloudUrl) return null;
      try {
        return await fetchSoundCloudDetails(soundcloudUrl, soundcloudUrl);
      } catch {
        return null;
      }
    })();

    // SoundCloud is the preferred source, but it must not hold the play button
    // hostage: give it a short head start, then take JioSaavn if that is ready
    // first. Both lookups are already running in parallel, so the user waits
    // for one provider, never for the sum of two.
    // Hard budget per stage. A provider that misses its window is abandoned
    // rather than waited on — the user gets a fast failure on the next
    // provider instead of a spinner that never ends.
    //
    // SoundCloud is the preferred source, so it gets the first window
    // (2.2s), but that window must be SHORT: SoundCloud's lookup is two
    // network hops and can take 2-8s, and the user should not sit through
    // it — JioSaavn, already running in parallel, is usually ready in ~1s.
    const soundcloudFirst = await withDeadline(soundCloudPromise, 2200, null);
    if (soundcloudFirst) return soundcloudFirst;

    const jioSaavnPayload = await withDeadline(jioSaavnPromise, 3500, null);
    if (jioSaavnPayload) return jioSaavnPayload;

    // JioSaavn missed too — take whatever SoundCloud eventually found.
    const soundcloudPayload = await withDeadline(soundCloudPromise, 3500, null);
    if (soundcloudPayload) return soundcloudPayload;

    const youtubeId = await withDeadline(
      findYouTubeMatchForTrack(title, artist, options?.duration),
      8000,
      null,
    );
    if (youtubeId) {
      const youtubePayload = await withDeadline(
        fetchVideoDetails(youtubeId, runId, "youtube", { title, artist }),
        8000,
        null,
      );
      if (youtubePayload) return youtubePayload;
    }

    throw new Error(`No playable source found for ${source} track`);
  }

  if (source === "jiosaavn") {
    const providerEndpoints = await getProviderEndpoints();
    const jioSaavnPayload = await fetchJioSaavnFromEndpoints(
      buildJioSaavnSongEndpoints(
        videoId,
        providerEndpoints.providers.jiosaavn.apiBase,
        options?.urlHint,
      ),
    );
    if (jioSaavnPayload?.audioUrl) return jioSaavnPayload;
    throw new Error("Failed to fetch JioSaavn audio stream");
  }

  throw new Error(`Unsupported source: ${source || "unknown"}`);
}

export async function GET(request: NextRequest) {
  const blockedResponse = requireStreamifyRequest(request);
  if (blockedResponse) return blockedResponse;

  const { searchParams } = new URL(request.url);
  const videoId = searchParams.get("id");
  const source = searchParams.get("source") || undefined;
  const title = searchParams.get("title") || undefined;
  const artist = searchParams.get("artist") || undefined;
  const urlHint = searchParams.get("url") || undefined;
  const providerHint = searchParams.get("providerHint") || undefined;
  const prewarm = searchParams.get("prewarm") === "1";
  const runId = `pre-${Date.now()}`;
  const requestKey = [
    source || "youtube",
    videoId || "",
    title || "",
    artist || "",
  ]
    .join("::")
    .toLowerCase();

  // #region debug-point A:video-route-entry
  reportDebugEvent(
    runId,
    "A",
    "app/api/video/route.ts:GET:entry",
    "[DEBUG] /api/video request received",
    {
      url: request.url,
      videoId,
      originalVideoId: videoId,
      source,
    },
  );
  // #endregion

  if (prewarm) {
    if (source === "soundcloud") {
      await Promise.allSettled([
        getProviderEndpoints({ revalidate: true }),
        getSoundCloudClientId(),
      ]);
      return NextResponse.json({ ok: true, source: "soundcloud" });
    }

    if (source === "youtube" || source === "youtubemusic" || !source) {
      await Promise.allSettled([getInvidiousInstances(), getPipedInstances()]);
      return NextResponse.json({ ok: true, source: source || "youtube" });
    }
  }

  if (!videoId) {
    // #region debug-point A:video-route-missing-id
    reportDebugEvent(
      runId,
      "A",
      "app/api/video/route.ts:GET:missing-id",
      "[DEBUG] /api/video missing id",
      {
        url: request.url,
      },
    );
    // #endregion
    return NextResponse.json(
      { error: "Video ID is required" },
      { status: 400 },
    );
  }

  // Extract video ID from YouTube URL if the ID contains a full URL
  let cleanVideoId = videoId;
  if (videoId.includes("/watch?v=")) {
    const match = videoId.match(/[?&]v=([^&]+)/);
    if (match?.[1]) {
      cleanVideoId = match[1];
    }
  } else if (videoId.includes("youtu.be/")) {
    const match = videoId.match(/youtu\.be\/([^?]+)/);
    if (match?.[1]) {
      cleanVideoId = match[1];
    }
  }

  const cached = cache.get(requestKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // #region debug-point A:video-route-cache-hit
    reportDebugEvent(
      runId,
      "A",
      "app/api/video/route.ts:GET:cache-hit",
      "[DEBUG] /api/video cache hit",
      {
        videoId,
        source,
        ageMs: Date.now() - cached.at,
      },
    );
    // #endregion
    return NextResponse.json(cached.value);
  }

  try {
    let requestPromise = inflightRequests.get(requestKey);
    if (!requestPromise) {
      requestPromise = fetchVideoDetails(cleanVideoId, runId, source, {
        title,
        artist,
        urlHint,
        providerHint,
        duration: Number(searchParams.get("duration")) || undefined,
      }).finally(() => {
        inflightRequests.delete(requestKey);
      });
      inflightRequests.set(requestKey, requestPromise);
    }

    const value = await requestPromise;
    cache.set(requestKey, { at: Date.now(), value });
    return NextResponse.json(value);
  } catch (error) {
    if (cached && Date.now() - cached.at < STALE_CACHE_TTL_MS) {
      reportDebugEvent(
        runId,
        "E",
        "app/api/video/route.ts:GET:stale-cache-fallback",
        "[DEBUG] /api/video serving stale cache after provider failure",
        {
          videoId,
          source,
          ageMs: Date.now() - cached.at,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return NextResponse.json(cached.value);
    }

    // #region debug-point E:video-route-unhandled
    reportDebugEvent(
      runId,
      "E",
      "app/api/video/route.ts:GET:unhandled",
      "[DEBUG] /api/video unhandled error",
      {
        videoId,
        source,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    // #endregion
    const message = error instanceof Error ? error.message : String(error);

    // "Nothing matched" is a normal outcome for a track the providers do not
    // have — report it as 404 so the client can say "unavailable" instead of
    // showing a generic server failure.
    if (/No playable source found|No streaming match/i.test(message)) {
      return NextResponse.json(
        { error: "No playable source found", details: message },
        { status: 404 },
      );
    }

    console.error("Failed to fetch video details:", error);
  }

  return NextResponse.json(
    { error: "Failed to fetch video details" },
    { status: 500 },
  );
}
