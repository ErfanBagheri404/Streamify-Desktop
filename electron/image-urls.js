// Turning an app cover URL into something an EXTERNAL service can fetch.
//
// The renderer stores cover URLs as routes on its own Next server — every
// YouTube cover is `/api/youtube-thumbnail?…` (normalizeYouTubeThumbnailUrl),
// and artist art goes through `/api/invidious-image?url=…`. That is correct
// for us: the app fetches its own bytes, no CORS, resizing, upstream fallback.
//
// It is wrong for anything that fetches the image itself over the public
// internet. Discord is the case we hit: SET_ACTIVITY hands `assets.large_image`
// to Discord's servers, which cannot reach 127.0.0.1, so the asset silently
// fails to resolve and the card falls back to the application icon — which is
// exactly why a YouTube card showed the Streamify logo where Spotify's
// i.scdn.co URL showed cover art.
//
// So: rewrite our own image routes back to the public origin they stand for,
// and drop anything else that is only reachable on this machine. The proxy's
// w/h/q params are cosmetic (wsrv.nl resizing) — the consumer scales the asset
// itself, so the plain upstream image is the right thing to send.

// 10/8, 172.16/12 and 192.168/16 ranges plus loopback, since a local URL that
// only this machine can resolve is useless to an external fetcher.
const LOCAL_HOST_RE =
  /^(localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|10\.(?:\d{1,3}\.){3}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|::1)$/i;

function isLocalHost(hostname) {
  return LOCAL_HOST_RE.test(String(hostname || "").replace(/^\[|\]$/g, ""));
}

// Mirrors app/app/lib/youtube-thumbnails.ts. Main is plain JS and cannot import
// the renderer's TS module, so the shape is restated here.
function youTubeImageUrl(params) {
  const videoId = (params.get("id") || "").trim();
  if (!videoId) return null;
  const variant = (params.get("variant") || "maxresdefault.jpg").trim();
  const webp = params.get("webp") === "1";
  const base = webp ? "https://i.ytimg.com/vi_webp/" : "https://i.ytimg.com/vi/";
  return `${base}${encodeURIComponent(videoId)}/${encodeURIComponent(variant)}`;
}

// Accept only a publicly resolvable http(s) URL.
function publicHttpOrNull(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    return isLocalHost(parsed.hostname) ? null : parsed.toString();
  } catch {
    return null;
  }
}

function publicImageUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  let url;
  try {
    // Root-relative ("/api/…") is by definition served by this app, so base it
    // somewhere local and let the path matching below resolve it.
    url = new URL(raw, "http://127.0.0.1");
  } catch {
    return publicHttpOrNull(raw);
  }

  if (url.pathname === "/api/youtube-thumbnail") {
    return youTubeImageUrl(url.searchParams);
  }
  if (url.pathname === "/api/invidious-image") {
    return publicHttpOrNull(url.searchParams.get("url"));
  }
  return publicHttpOrNull(url.toString());
}

// The cover an external service should fetch for a track.
function coverUrlFor(song) {
  const direct = publicImageUrl(song && song.coverUrl);
  if (direct) return direct;
  // A YouTube track with no usable cover still carries a video id, which is
  // enough for the public thumbnail — that is how the player bar gets its art.
  if (song && /^youtube/i.test(String(song.source || "")) && song.id) {
    return youTubeImageUrl(new URLSearchParams({ id: song.id }));
  }
  return null;
}

module.exports = {
  coverUrlFor,
  publicImageUrl,
  publicHttpOrNull,
  youTubeImageUrl,
  isLocalHost,
};
