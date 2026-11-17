// Last.fm scrobbling for the desktop shell.
//
// Credentials live at userData/lastfm.json (override dir: STREAMIFY_LASTFM_DIR,
// used by the self-check) and never reach the renderer — the bridge only ever
// reports { connected, username, hasCredentials, pendingAuth }.
//
// Every call is signed: api_sig = md5(concat of name+value over the params
// sorted by name, + apiSecret). `format` and `api_sig` itself are excluded
// from the signature, per the Last.fm spec.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API_URL = "https://ws.audioscrobbler.com/2.0/";
const AUTH_URL = "https://www.last.fm/api/auth/";

function sign(params, apiSecret) {
  const raw = Object.keys(params)
    .filter((key) => key !== "format" && key !== "callback")
    .sort()
    .map((key) => key + String(params[key]))
    .join("");
  return crypto.createHash("md5").update(raw + apiSecret).digest("hex");
}

// ---- credentials ------------------------------------------------------------

let credsCache; // undefined = not read yet
let pendingToken = null; // auth.getToken result awaiting auth.getSession

function credentialsFile() {
  const dir =
    process.env.STREAMIFY_LASTFM_DIR ||
    require("electron").app.getPath("userData");
  return path.join(dir, "lastfm.json");
}

function readCreds() {
  if (credsCache === undefined) {
    try {
      credsCache =
        JSON.parse(fs.readFileSync(credentialsFile(), "utf8")) || null;
    } catch {
      credsCache = null;
    }
  }
  return credsCache;
}

function writeCreds(next) {
  credsCache = next;
  try {
    const file = credentialsFile();
    if (next) {
      fs.writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (error) {
    console.warn("[lastfm] saving credentials failed:", error?.message || error);
  }
}

function getStatus() {
  const creds = readCreds();
  return {
    connected: Boolean(creds?.sessionKey),
    username: creds?.username || null,
    hasCredentials: Boolean(creds?.apiKey && creds?.apiSecret),
    pendingAuth: Boolean(pendingToken),
  };
}

function setCredentials(input) {
  const creds = { ...(readCreds() || {}) };
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const apiSecret =
    typeof input?.apiSecret === "string" ? input.apiSecret.trim() : "";
  if (apiKey) creds.apiKey = apiKey;
  if (apiSecret) creds.apiSecret = apiSecret;
  if (apiKey || apiSecret) {
    // New keys invalidate the old session.
    delete creds.sessionKey;
    delete creds.username;
  }
  writeCreds(Object.keys(creds).length ? creds : null);
  return getStatus();
}

function disconnect() {
  pendingToken = null;
  const creds = { ...(readCreds() || {}) };
  delete creds.sessionKey;
  delete creds.username;
  writeCreds(Object.keys(creds).length ? creds : null);
  return getStatus();
}

// ---- API -------------------------------------------------------------------

async function call(method, params) {
  const creds = readCreds();
  if (!creds?.apiKey || !creds?.apiSecret) throw new Error("no-credentials");
  // format/api_sig stay out of the signature.
  const signed = { ...params, api_key: creds.apiKey, method };
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(signed)) {
    body.set(key, String(value));
  }
  body.set("format", "json");
  body.set("api_sig", sign(signed, creds.apiSecret));
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await response.json();
  if (data?.error) {
    throw new Error(
      `Last.fm error ${data.error}: ${data.message || "request failed"}`
    );
  }
  return data;
}

async function authToken() {
  const data = await call("auth.getToken", {});
  pendingToken = data.token;
  return pendingToken;
}

async function authSession(token) {
  const creds = readCreds();
  const data = await call("auth.getSession", { token });
  const session = data.session || {};
  writeCreds({ ...creds, sessionKey: session.key, username: session.name });
  pendingToken = null;
  return session.name;
}

async function startAuth() {
  try {
    const token = await authToken();
    const { apiKey } = readCreds();
    require("electron").shell.openExternal(
      `${AUTH_URL}?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`
    );
    // The token stays in main; the renderer only needs the side effect.
    return { ok: true };
  } catch (error) {
    console.warn("[lastfm] startAuth failed:", error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function finishAuth() {
  if (!pendingToken) return { ok: false, error: "no-pending-token" };
  try {
    const username = await authSession(pendingToken);
    return { ok: true, username };
  } catch (error) {
    console.warn("[lastfm] finishAuth failed:", error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function test() {
  const creds = readCreds();
  if (!creds?.sessionKey) return { ok: false, error: "not-connected" };
  try {
    const data = await call("user.getInfo", { sk: creds.sessionKey });
    return { ok: true, username: data?.user?.name || creds.username || null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function trackParams(track, sessionKey) {
  const params = { sk: sessionKey, artist: track.artist, track: track.title };
  if (track.album) params.album = track.album;
  if (Number(track.duration) > 0) params.duration = Math.round(track.duration);
  return params;
}

// Both are fire-and-forget: Last.fm being slow or down must never disturb
// playback, so errors are logged and swallowed here.
async function nowPlaying(track) {
  if (!readCreds()?.sessionKey) return;
  try {
    await call("track.updateNowPlaying", trackParams(track, readCreds().sessionKey));
  } catch (error) {
    console.warn("[lastfm] updateNowPlaying failed:", error?.message || error);
  }
}

async function scrobble(track, timestamp) {
  if (!readCreds()?.sessionKey) return;
  try {
    await call("track.scrobble", {
      ...trackParams(track, readCreds().sessionKey),
      timestamp: Math.round(timestamp),
    });
  } catch (error) {
    console.warn("[lastfm] scrobble failed:", error?.message || error);
  }
}

// ---- scrobble rules ---------------------------------------------------------
// Listen window: half the track, capped at 240s, and only for tracks of at
// least 30s (the Last.fm floor).
function scrobbleThreshold(duration) {
  if (!Number.isFinite(duration) || duration < 30) return null;
  return Math.min(240, duration * 0.5);
}

function shouldScrobble(duration, listened) {
  const threshold = scrobbleThreshold(duration);
  return threshold !== null && listened >= threshold;
}

// ---- tracking (piggybacks on desktop:now-playing / desktop:position) -------

let enabled = false;
// One play: { key, track, startedAt, listened, scrobbled, playing, lastPos }.
// Same song id = same play session, so pause/resume reports keep the
// accumulated listened seconds instead of restarting the clock.
// ponytail: a back-to-back replay of the SAME track is not scrobbled twice —
// needs a play nonce from the renderer if that ever matters.
let play = null;

function setEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) play = null;
}

function onNowPlaying(payload) {
  const song = payload?.song;
  if (!enabled || !readCreds()?.sessionKey) {
    play = null;
    return;
  }
  if (!song) {
    flush();
    return;
  }
  const key = String(song.id ?? `${song.artist}|${song.title}`);
  if (play && play.key === key) {
    const resumed = !play.playing && !!payload.isPlaying;
    play.playing = !!payload.isPlaying;
    // Last.fm clears "now playing" after a while; re-announce on resume.
    if (resumed) void nowPlaying(play.track);
    // A pause can strand a finished listen; flush it right away.
    if (!play.playing) maybeScrobble();
    return;
  }
  flush();
  play = {
    key,
    track: {
      artist: song.artist,
      title: song.title,
      album: song.album,
      duration: Number(song.duration) || 0,
    },
    // Unix seconds at playback start.
    startedAt: Math.floor(Date.now() / 1000),
    listened: 0,
    scrobbled: false,
    playing: !!payload.isPlaying,
    lastPos: Number(payload.position) || 0,
  };
  void nowPlaying(play.track);
}

function onPosition(seconds) {
  if (!play) return;
  const position = Number(seconds);
  if (!Number.isFinite(position) || position < 0) return;
  const previous = play.lastPos;
  play.lastPos = position;
  if (!play.playing || previous == null) return;
  const delta = position - previous;
  // Counts only while playing; the cap keeps a forward seek from reading as
  // listened time.
  if (delta > 0) play.listened += Math.min(delta, 5);
  maybeScrobble();
}

function maybeScrobble() {
  if (!play || play.scrobbled) return;
  if (!shouldScrobble(play.track.duration, play.listened)) return;
  play.scrobbled = true;
  void scrobble(play.track, play.startedAt);
}

// Track change / playback stop / quit: settle the play, then drop it.
function flush() {
  if (!play) return;
  maybeScrobble();
  play = null;
}

module.exports = {
  sign,
  scrobbleThreshold,
  shouldScrobble,
  getStatus,
  setCredentials,
  disconnect,
  startAuth,
  finishAuth,
  test,
  nowPlaying,
  scrobble,
  setEnabled,
  onNowPlaying,
  onPosition,
  flush,
};
