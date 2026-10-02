// Desktop OS integration that only exists outside the browser: system
// "Now Playing" notifications and the Linux MPRIS D-Bus service.
//
// Both are thin bridges. Playback state lives in the renderer's AudioContext,
// so every function here either mirrors a pushed state or forwards a command
// back over the same `desktop:command` channel the menu and media keys use.
// Nothing re-implements playback.
const { app, Notification, nativeImage } = require("electron");
const http = require("http");
const https = require("https");

// notification -> tray -> menu all speak the same command vocabulary.
const COMMANDS = new Set(["play-pause", "next", "previous"]);

// Cached data-URL artwork, keyed by song id. Covers come from remote hosts
// (yt3.ggpht.com, i.scdn.co), and a notification cannot fetch them itself.
const artworkCache = new Map();

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

// main.js owns the boot log (Windows GUI binaries lose stdout). It is injected
// via setIntegrationHooks rather than required here — requiring main.js from
// this module would re-run its top-level single-instance lock and IPC setup.
let bootLog = () => {};

// ---- Now Playing notification ---------------------------------------------

let currentNotification = null;
let lastNotifiedKey = "";

function releaseArtwork(songId) {
  if (!artworkCache.has(songId)) return;
  artworkCache.delete(songId);
}

// Electron never frees the bitmaps it decodes, so a long session with big
// covers would grow without bound. A handful of recent covers is plenty: the
// notification only ever shows the current track.
const ARTWORK_CACHE_LIMIT = 8;

function fetchArtwork(url) {
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url)) return resolve(null);
    // http.get throws ERR_INVALID_PROTOCOL on https: URLs, so dispatch on the
    // scheme. A missed cover must never crash the app — hence the resolve(null)
    // handlers on every failure path.
    const transport = /^https:\/\//i.test(url) ? https : http;
    const request = transport.get(
      url,
      { timeout: 8000, headers: { "User-Agent": "Streamify-Desktop" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return resolve(null);
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (!chunks.length) return resolve(null);
          resolve({
            buffer: Buffer.concat(chunks),
            mime: response.headers["content-type"] || "image/jpeg",
          });
        });
      }
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
  });
}

async function resolveArtwork(song) {
  if (!song || !song.coverUrl) return null;
  const cached = artworkCache.get(song.id);
  if (cached) return cached;

  const payload = await fetchArtwork(song.coverUrl);
  if (!payload) return null;

  // Electron's Notification only takes a data: URL, and a raw remote URL leaks
  // the cover request to the CDN a second time (Electron cannot load it here).
  const entry = {
    dataUrl: `data:${payload.mime};base64,${payload.buffer.toString("base64")}`,
    source: song.coverUrl,
  };
  artworkCache.set(song.id, entry);
  if (artworkCache.size > ARTWORK_CACHE_LIMIT) {
    artworkCache.delete(artworkCache.keys().next().value);
  }
  return entry;
}

function buildActions(song, hasNext) {
  const actions = [];
  if (hasNext) {
    actions.push({
      text: "Next",
      click: () => sendCommand("next"),
    });
  }
  actions.push({
    text: "Open Streamify",
    click: () => showWindow(),
  });
  return actions;
}

let showWindowRef = () => {};
let sendCommandRef = () => {};

function setIntegrationHooks(hooks) {
  showWindowRef = hooks.showWindow || showWindowRef;
  sendCommandRef = hooks.sendCommand || sendCommandRef;
  bootLog = hooks.bootLog || bootLog;
}

// The OS groups notifications by `tag`, so re-notifying for a different track
// replaces the previous one instead of stacking. A pause on the same track must
// not re-notify, hence the key guard.
async function showNowPlaying(song, state) {
  if (!song || !Notification.isSupported()) return;
  if (!song.title) return;

  const key = `${song.id}:${state.isPlaying}`;
  if (key === lastNotifiedKey) return;
  lastNotifiedKey = key;
  bootLog(
    `[now-playing] ${state.isPlaying ? "playing" : "paused"} — ${song.title}` +
      (song.artist ? ` — ${song.artist}` : "")
  );

  const artwork = await resolveArtwork(song);
  const icon = artwork ? nativeImage.createFromDataURL(artwork.dataUrl) : undefined;

  if (currentNotification) currentNotification.close();

  const notification = new Notification({
    title: song.title,
    body: song.artist,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    silent: true,
    // One slot per song so a new track replaces the old bubble on Windows and
    // macOS instead of filling the notification centre.
    tag: `streamify-${song.id}`,
  });

  notification.on("click", () => showWindowRef());
  notification.show();
  currentNotification = notification;
}

function clearNowPlaying() {
  if (!currentNotification) return;
  currentNotification.close();
  currentNotification = null;
  lastNotifiedKey = "";
}

// ---- MPRIS (Linux D-Bus) ---------------------------------------------------

// Lazy-loaded: mpris-service opens the session bus in its constructor, which
// throws on Windows and macOS (no DBUS_SESSION_BUS_ADDRESS). Requiring it only
// on Linux, inside the call, keeps the other platforms from ever seeing it.
let mprisPlayer = null;
let mprisState = { position: 0, canGoNext: false, canGoPrevious: false };

function mprisEnabled() {
  return process.platform === "linux" && !!process.env.DBUS_SESSION_BUS_ADDRESS;
}

function wireMpris() {
  if (!mprisEnabled()) return;

  let Player;
  try {
    Player = require("mpris-service");
  } catch (error) {
    bootLog(`[mpris] module unavailable: ${error && error.message}`);
    return;
  }

  try {
    mprisPlayer = new Player({
      name: "streamify",
      identity: "Streamify Desktop",
      // The app is a web app: it plays HTTPS audio it hands to the OS, it does
      // not open local files, so there is no scheme to advertise.
      supportedUriSchemes: [],
      supportedMimeTypes: [],
      desktopEntry: "streamify-desktop",
      supportedInterfaces: ["player"],
    });
  } catch (error) {
    bootLog(`[mpris] could not register on the session bus: ${error && error.message}`);
    mprisPlayer = null;
    return;
  }

  // MPRIS method calls are method-invocations on a remote bus, so they come
  // in as events rather than direct method calls. They reuse the same command
  // vocabulary as the tray, the app menu and the media keys.
  const forward = (command) => () => sendCommandRef(command);
  mprisPlayer.on("playpause", forward("play-pause"));
  mprisPlayer.on("play", () => sendCommandRef("play"));
  mprisPlayer.on("pause", () => sendCommandRef("pause"));
  mprisPlayer.on("stop", () => sendCommandRef("pause"));
  mprisPlayer.on("next", forward("next"));
  mprisPlayer.on("previous", forward("previous"));
  mprisPlayer.on("raise", () => showWindowRef());
  mprisPlayer.on("quit", () => {
    app.quit();
  });
  // MPRIS carries Seek/SetPosition in MICROseconds; the renderer speaks seconds.
  mprisPlayer.on("seek", (offsetUs) => sendCommandRef("seek", Number(offsetUs || 0) / 1e6));
  mprisPlayer.on("position", (event) =>
    sendCommandRef("seek", Number(event?.position || 0) / 1e6)
  );

  // The DE reads Position as a property, not a signal, so it must be served on
  // demand — this is what makes the desktop's seek bar show real progress.
  mprisPlayer.getPosition = () => Math.max(0, Math.round(mprisState.position * 1e6));

  mprisPlayer.on("error", (error) => {
    bootLog(`[mpris] ${error && error.message}`);
  });

  bootLog("[mpris] registered org.mpris.MediaPlayer2.streamify");
}

function publishMpris(song, state) {
  if (!mprisPlayer) return;
  mprisState = {
    position: state.position,
    canGoNext: !!state.hasNext,
    canGoPrevious: !!state.hasPrevious,
  };

  mprisPlayer.playbackStatus = state.isPlaying
    ? "Playing"
    : song
      ? "Paused"
      : "Stopped";

  if (!song) {
    mprisPlayer.metadata = {
      "mpris:trackid": mprisPlayer.objectPath("track/none"),
    };
    return;
  }

  mprisPlayer.metadata = {
    "mpris:trackid": mprisPlayer.objectPath(`track/${song.id}`),
    "mpris:length": Math.max(0, Math.round((song.duration || 0) * 1e6)),
    "xesam:title": song.title || "Unknown Track",
    "xesam:artist": [song.artist || "Unknown Artist"],
    ...(mprisArtworkUrl(song) ? { "mpris:artUrl": mprisArtworkUrl(song) } : {}),
  };
  mprisPlayer.canPlay = true;
  mprisPlayer.canPause = true;
  mprisPlayer.canGoNext = mprisState.canGoNext;
  mprisPlayer.canGoPrevious = mprisState.canGoPrevious;
}

// The DE renders this art itself, so it must be a real http(s) URL — unlike
// the notification, which needs a data: URL. Prefer the already-cached
// download, fall back to the original cover URL.
function mprisArtworkUrl(song) {
  if (!song || !song.coverUrl) return null;
  const cached = artworkCache.get(song.id);
  if (cached) return cached.source;
  return song.coverUrl;
}

function publishMprisPosition(positionSeconds) {
  if (!mprisPlayer) return;
  mprisPlayer.seeked(Math.max(0, Math.round(positionSeconds * 1e6)));
}

function dispose() {
  clearNowPlaying();
  artworkCache.clear();
  mprisPlayer = null;
}

module.exports = {
  wireMpris,
  showNowPlaying,
  clearNowPlaying,
  publishMpris,
  publishMprisPosition,
  setIntegrationHooks,
  dispose,
  COMMANDS,
};
