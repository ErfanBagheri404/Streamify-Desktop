import { buildProviderUrlCandidates, type WorkerConfig } from "../config";
import { toArray, toNumber, toRecord, withTimeout } from "../http";
import {
  buildJioSaavnStyleTrack,
  findJioSaavnPlayback,
  type ExternalCatalogTrack,
} from "./jiosaavn-match";

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(25, Math.round(value)));
}

// Keyless web-player GraphQL search: the official api.spotify.com route needs
// a Premium-owning registered app (Feb 2026), so search goes through Spotify's
// own public web-player persisted queries + the keyless embed token.
const SPOTIFY_PARTNER_BASE = "https://api-partner.spotify.com";
const SPOTIFY_SEARCH_OP_HASH =
  "f78953bf9207d73493c27284103f5aeb6e728876d5793851bf79bc706127ff70";
export const SPOTIFY_LOOKUP_OP_HASH =
  "f952da037440f694cc6925b9e3f649d39077a744c4db7dfba01cb883723f4f77";

let cachedSpotifyEmbedToken: { value: string; expiresAt: number } | null = null;

async function getSpotifyEmbedToken(force = false): Promise<string> {
  if (
    cachedSpotifyEmbedToken &&
    !force &&
    cachedSpotifyEmbedToken.expiresAt > Date.now() + 30_000
  ) {
    return cachedSpotifyEmbedToken.value;
  }

  const response = await fetch("https://open.spotify.com/embed/api/token", {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: withTimeout(undefined, 10000),
  });
  if (!response.ok)
    throw new Error(`Spotify embed token HTTP ${response.status}`);

  const payload = toRecord(await response.json());
  const accessToken =
    typeof payload.accessToken === "string" ? payload.accessToken : "";
  if (!accessToken)
    throw new Error("Spotify embed token missing accessToken");

  const expiresIn = toNumber(payload.expiresAt) || 3600;
  cachedSpotifyEmbedToken = {
    value: accessToken,
    expiresAt:
      expiresIn > 10_000_000_000 ? expiresIn : Date.now() + expiresIn * 1000,
  };
  return accessToken;
}

export async function spotifyPartnerQuery(
  variables: Record<string, unknown>,
  hash: string,
): Promise<Record<string, unknown>> {
  for (const force of [false, true]) {
    const token = await getSpotifyEmbedToken(force);
    const response = await fetch(
      `${SPOTIFY_PARTNER_BASE}/pathfinder/v1/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://open.spotify.com",
          Referer: "https://open.spotify.com/",
        },
        body: JSON.stringify({
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
        cache: "no-store",
        signal: withTimeout(undefined, 12000),
      },
    );
    if (response.status === 401 && !force) continue;
    if (!response.ok)
      throw new Error(`Spotify search HTTP ${response.status}`);
    return toRecord(await response.json());
  }
  throw new Error("Spotify search HTTP 401");
}

function collectSpotifyUris(
  value: unknown,
  bucket: string[],
  limit: number,
): void {
  if (bucket.length >= limit * 6) return;
  if (typeof value === "string") {
    if (
      /^spotify:(track|album|artist|playlist|show|episode):[A-Za-z0-9]{10,}/.test(
        value,
      )
    )
      bucket.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSpotifyUris(entry, bucket, limit);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectSpotifyUris(entry, bucket, limit);
    }
  }
}

function lookupSpotifyEntityKind(entry: Record<string, unknown>): string {
  const kind = toRecord(entry.entityTypeTrait).type;
  if (kind === "ENTITY_TYPE_ARTIST") return "artist";
  if (kind === "ENTITY_TYPE_ALBUM") return "album";
  return "";
}

export function pickSpotifyLookupCover(album: Record<string, unknown>): string {
  let best = "";
  let bestSize = 0;
  for (const source of toArray(
    toRecord(album.coverArt).sources,
  ).map(toRecord)) {
    const url = typeof source.url === "string" ? source.url : "";
    const width = toNumber(source.width) || 0;
    if (url && width >= bestSize) {
      best = url;
      bestSize = width;
    }
  }
  return best;
}

function normalizeLookupTrack(
  entry: Record<string, unknown>,
): ExternalCatalogTrack | null {
  const uri = typeof entry.uri === "string" ? entry.uri : "";
  const idMatch = uri.match(/^spotify:track:([A-Za-z0-9]{10,})/);
  if (!idMatch) return null;

  const data = toRecord(toRecord(entry.typedEntity).data);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) return null;

  const artists = toArray(toRecord(data.artists).items)
    .map((item) => {
      const profile = toRecord(toRecord(item).profile);
      return typeof profile.name === "string" ? profile.name.trim() : "";
    })
    .filter(Boolean)
    .join(", ");

  const album = toRecord(data.albumOfTrack);
  const duration = toRecord(
    toRecord(entry.consumptionExperienceTrait).duration,
  );
  const seconds = toNumber(duration.seconds);

  return {
    provider: "spotify",
    id: idMatch[1],
    title: name,
    artist: artists || "Unknown Artist",
    coverUrl: pickSpotifyLookupCover(album),
    duration: seconds != null && seconds > 0 ? seconds : undefined,
    album:
      typeof album.name === "string" ? album.name.trim() : undefined,
  };
}

function lookupSpotifyEntityName(entry: Record<string, unknown>): string {
  const identity = toRecord(entry.identityTrait);
  const name = typeof identity.name === "string" ? identity.name.trim() : "";
  if (name) return name;
  const data = toRecord(toRecord(entry.typedEntity).data);
  return typeof data.name === "string" ? data.name.trim() : "";
}

// Keyless artwork + subtitle for album/artist search results.
async function fetchSpotifyEntityCard(
  kind: "album" | "artist",
  id: string,
  name: string,
): Promise<Record<string, unknown>> {
  let cover = "";
  let subtitle = "";
  let trackCount = 0;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(
        `https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "text/html",
          },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (res.ok) {
        const html = await res.text();
        const match = html.match(
          /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
        );
        const data = match?.[1]
          ? toRecord(
              toRecord(
                toRecord(toRecord(JSON.parse(match[1])).props).pageProps,
              ).state,
            )
          : {};
        const entity = toRecord(toRecord(data.data).entity);
        const entityName =
          typeof entity.name === "string" ? entity.name.trim() : "";
        if (entityName) name = entityName;
        if (typeof entity.subtitle === "string") {
          subtitle = entity.subtitle.trim();
        }
        if (kind === "artist" && subtitle === "Top tracks") subtitle = "Artist";
        const images = toArray(toRecord(entity.visualIdentity).image).map(
          toRecord,
        );
        let best = 0;
        for (const image of images) {
          const url = typeof image.url === "string" ? image.url.trim() : "";
          const area =
            (toNumber(image.maxWidth) || 0) * (toNumber(image.maxHeight) || 0);
          if (url && area >= best) {
            cover = url;
            best = area;
          }
        }
        trackCount = toArray(entity.trackList).length;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // artwork is cosmetic; a name-only card still navigates
  }

  return {
    id,
    title: name,
    name,
    subtitle,
    artist: subtitle,
    thumbnailUrl: cover,
    img: cover,
    coverUrl: cover,
    url: `https://open.spotify.com/${kind}/${id}`,
    href: `https://open.spotify.com/${kind}/${id}`,
    type: kind,
    source: "spotify",
    isPlayable: false,
    videoCount: trackCount,
    songCount: trackCount,
  };
}

export async function searchSpotifyCatalog(
  query: string,
  limit: number,
  filter: string | undefined,
  config: WorkerConfig,
): Promise<Record<string, unknown>[]> {
  const safeLimit = Math.max(1, Math.min(20, clampLimit(limit)));
  const wanted =
    filter === "artists" || filter === "artist"
      ? "artist"
      : filter === "albums" || filter === "album"
        ? "album"
        : filter === "songs" || filter === "song"
          ? "track"
          : "all";

  // Spotify's search op defaults to ~5 rows per bucket; pass limit explicitly.
  const searchLimit = Math.min(Math.max(safeLimit * 6, 30), 90);
  const payload = await spotifyPartnerQuery(
    { term: query.trim(), limit: searchLimit },
    SPOTIFY_SEARCH_OP_HASH,
  );

  const uris: string[] = [];
  collectSpotifyUris(toRecord(payload.data).searchV2, uris, searchLimit);
  if (!uris.length) return [];

  // "all" blends artists + albums + songs; the search op returns ~5
  // URIs per bucket so a single lookup covers every kind.
  const prefixes =
    wanted === "artist"
      ? ["spotify:artist:"]
      : wanted === "album"
        ? ["spotify:album:"]
        : wanted === "track"
          ? ["spotify:track:"]
          : ["spotify:artist:", "spotify:album:", "spotify:track:"];

  const picked: string[] = [];
  for (const prefix of prefixes) {
    for (const uri of uris) {
      if (uri.startsWith(prefix) && !picked.includes(uri)) picked.push(uri);
    }
  }
  if (!picked.length) return [];

  const lookup = await spotifyPartnerQuery(
    { uris: picked },
    SPOTIFY_LOOKUP_OP_HASH,
  );
  const entities = toArray(toRecord(lookup.data).lookupEntities).map(toRecord);

  const cardSpecs: { kind: "album" | "artist"; id: string; name: string }[] = [];
  const tracks: ExternalCatalogTrack[] = [];
  for (const entry of entities) {
    const kind = lookupSpotifyEntityKind(entry);
    const id =
      typeof entry.uri === "string" ? entry.uri.split(":").pop() || "" : "";
    if (!id) continue;
    if (kind === "artist" || kind === "album") {
      if (wanted === "artist" || wanted === "album") {
        if (kind !== wanted) continue;
      }
      const name = lookupSpotifyEntityName(entry);
      if (!name) continue;
      cardSpecs.push({ kind, id, name });
      continue;
    }
    if (wanted === "artist" || wanted === "album") continue;
    const track = normalizeLookupTrack(entry);
    if (track) tracks.push(track);
  }

  // Only the slots that survive the final slice need a cover fetch, and they
  // run in parallel -- sequential embed lookups ate the whole match budget.
  const isEntity = wanted === "artist" || wanted === "album";
  const cards = await Promise.all(
    cardSpecs
      .slice(0, isEntity ? safeLimit : 2)
      .map((spec) => fetchSpotifyEntityCard(spec.kind, spec.id, spec.name)),
  );

  const signal = withTimeout(undefined, 15000);
  const matchedTracks = await Promise.all(
    tracks.map(async (track) => {
      const playback = await findJioSaavnPlayback(config, track, signal);
      return playback ? buildJioSaavnStyleTrack(track, playback) : null;
    }),
  );
  const songs = matchedTracks.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry),
  );

  const items =
    wanted === "artist" || wanted === "album"
      ? cards
      : wanted === "track"
        ? songs
        : [...songs.slice(0, 2), ...cards.slice(0, 2), ...songs.slice(2)];

  return items.slice(0, safeLimit);
}
