import type { WorkerConfig } from "../config";
import { json, toArray, toNumber, toRecord, withTimeout } from "../http";
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
  const album = toRecord(track.album);
  const fields = [album.cover_xl, album.cover_big, album.cover_medium, album.cover];

  for (const field of fields) {
    if (typeof field === "string" && field.trim()) {
      return field;
    }
  }

  return "";
}

function normalizeDeezerTrack(track: Record<string, unknown>): ExternalCatalogTrack | null {
  const artistRecord = toRecord(track.artist);
  const albumRecord = toRecord(track.album);
  const title = typeof track.title === "string" ? track.title.trim() : "";
  const artist =
    typeof artistRecord.name === "string" ? artistRecord.name.trim() : "";
  const rawId = track.id;
  const id =
    typeof rawId === "string" && rawId.trim()
      ? rawId.trim()
      : typeof rawId === "number" && Number.isFinite(rawId)
      ? String(rawId)
      : "";

  if (!title || !artist || !id) return null;

  return {
    provider: "deezer",
    id,
    title,
    artist,
    coverUrl: pickArtwork(track),
    duration: toNumber(track.duration),
    album:
      typeof albumRecord.title === "string" ? albumRecord.title.trim() : undefined,
  };
}

export async function searchDeezerCatalog(
  query: string,
  config: WorkerConfig,
  limit = 20
): Promise<Record<string, unknown>[]> {
  const signal = withTimeout(undefined, 12000);
  const safeLimit = clampLimit(limit);
  const baseUrl = config.providers.deezer.apiBase || "https://api.deezer.com/search";
  const url = new URL(baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(safeLimit));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Deezer HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  const tracks = toArray(payload.data)
    .map((entry) => normalizeDeezerTrack(toRecord(entry)))
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

export async function handleDeezerSearch(
  request: Request,
  config: WorkerConfig
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim();
  const limit = clampLimit(toNumber(params.get("limit")));
  if (!q) return json({ items: [], nextpage: null }, { status: 200 });

  try {
    const items = await searchDeezerCatalog(q, config, limit);
    return json(
      { items, nextpage: null, providerHint: "deezer" },
      { status: 200 }
    );
  } catch (err) {
    return json(
      { items: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
