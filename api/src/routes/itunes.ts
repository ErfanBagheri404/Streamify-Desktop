import type { WorkerConfig } from "../config";
import { json, toArray, toRecord, toNumber, withTimeout } from "../http";
import {
  buildJioSaavnStyleTrack,
  findJioSaavnPlayback,
  type ExternalCatalogTrack,
} from "./jiosaavn-match";

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(25, Math.round(value)));
}

function pickArtwork(track: Record<string, unknown>): string {
  const artworkFields = [
    track.artworkUrl512,
    track.artworkUrl100,
    track.artworkUrl60,
    track.artworkUrl30,
  ];

  for (const field of artworkFields) {
    if (typeof field === "string" && field.trim()) {
      return field.replace(/\/\d+x\d+bb\./i, "/512x512bb.");
    }
  }

  return "";
}

function normalizeItunesTrack(track: Record<string, unknown>): ExternalCatalogTrack | null {
  const title =
    typeof track.trackName === "string" ? track.trackName.trim() : "";
  const artist =
    typeof track.artistName === "string" ? track.artistName.trim() : "";
  const idValue = track.trackId ?? track.collectionId;
  const id =
    typeof idValue === "string" && idValue.trim()
      ? idValue.trim()
      : typeof idValue === "number" && Number.isFinite(idValue)
      ? String(idValue)
      : "";

  if (!title || !artist || !id) return null;

  const durationMs = toNumber(track.trackTimeMillis);

  return {
    provider: "itunes",
    id,
    title,
    artist,
    coverUrl: pickArtwork(track),
    duration:
      durationMs != null && durationMs > 0 ? Math.round(durationMs / 1000) : undefined,
    album:
      typeof track.collectionName === "string" ? track.collectionName.trim() : undefined,
  };
}

export async function searchItunesCatalog(
  query: string,
  config: WorkerConfig,
  limit = 20
): Promise<Record<string, unknown>[]> {
  const signal = withTimeout(undefined, 12000);
  const safeLimit = clampLimit(limit);
  const baseUrl = config.providers.itunes.apiBase;
  const url = new URL(baseUrl);
  url.searchParams.set("term", query);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", String(safeLimit));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`iTunes HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { results?: unknown[] };
  const tracks = toArray(payload.results)
    .map((entry) => normalizeItunesTrack(toRecord(entry)))
    .filter((entry): entry is ExternalCatalogTrack => Boolean(entry));

  const matchedTracks = await Promise.all(
    tracks.map(async (track) => {
      const playback = await findJioSaavnPlayback(config, track, signal);
      return playback ? buildJioSaavnStyleTrack(track, playback) : null;
    })
  );

  return matchedTracks.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry)
  );
}

export async function handleItunesSearch(
  request: Request,
  config: WorkerConfig
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim();
  const limit = clampLimit(toNumber(params.get("limit")));
  if (!q) return json({ items: [], nextpage: null }, { status: 200 });

  try {
    const items = await searchItunesCatalog(q, config, limit);
    return json(
      { items, nextpage: null, providerHint: "itunes" },
      { status: 200 }
    );
  } catch (err) {
    return json(
      { items: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
