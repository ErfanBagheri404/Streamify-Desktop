// Discord Rich Presence: the same presence card Spotify publishes, fed from the
// same track + playback state the Now Playing notification and MPRIS use.
//
// Why local RPC and not the HTTP API: discord-rpc talks to the running Discord
// desktop client over a local named pipe. No OAuth, no access token, no user
// linking — the presence simply shows up next to the user's own name. The HTTP
// API would need a stored bot token and only works for bot accounts.
//
// Layout mirrors Spotify's card field for field:
//   type 2 (Listening) + "Streamify Desktop" -> the "Listening to ..." header
//   details = track title, state = artist
//   start/end timestamps -> Discord draws the progress bar and the elapsed and
//     total time labels, and animates them itself (we never resend while
//     playing; only on track change, pause and seek).
//   largeImage = cover art
const { app } = require("electron");
void app;

const crypto = require("crypto");

let client = null;
let clientReady = false;
let activityKey = "";
let lastSong = null;
let pendingActivity = null;

// Listen-along placeholder: Discord renders "Ask to Join" from a party block
// plus a join secret. Two blockers, both external: the flow needs the
// rpc.join scope + activity-join whitelist review, AND Discord currently
// rejects secrets sharing an activity with URL buttons ("secrets cannot
// currently be sent with buttons"). So party/secrets ship disabled —
// STREAMIFY_DISCORD_JOIN=1 sends them (and drops the URL buttons, which
// Discord requires). Card shape is then ready the day the app is approved.
const JOIN_ENABLED = process.env.STREAMIFY_DISCORD_JOIN === "1";
const partyId = `streamify.${crypto.randomBytes(6).toString("hex")}`;
const joinSecret = crypto.randomBytes(16).toString("base64url");

// Reconnect instead of staying dead: Discord is often launched after us, or
// restarts itself on update. setActivity on a dead client throws, and an
// unhandled rejection there would take the app down.
const RECONNECT_MS = 10000;

function clientId() {
  return String(process.env.STREAMIFY_DISCORD_CLIENT_ID || "").trim();
}

function enabled() {
  return !!clientId();
}

function log(line) {
  bootLogRef(`[discord] ${line}`);
}

function setBootLog(fn) {
  bootLogRef = fn || bootLogRef;
}

function rpcClient() {
  if (client) return client;
  if (!enabled()) return null;

  const { Client } = require("discord-rpc");
  client = new Client({ transport: "ipc" });

  client.on("ready", () => {
    clientReady = true;
    log(`connected as ${client.user ? client.user.tag : "?"}`);
    // Discord drops the presence on connect, and a track that is already
    // playing must reappear without waiting for the next report.
    const held = pendingActivity;
    pendingActivity = null;
    if (lastSong) void send(activityFor(lastSong, lastState), true);
    else if (held) {
      activityKey = "";
      void send(held);
    }
  });

  client.on("disconnected", () => {
    client = null;
    clientReady = false;
    activityKey = "";
    log("disconnected");
  });

  client.on("error", (error) => {
    const message = error && error.message;
    // "Could not connect" is the normal case: Discord isn't running. Expected,
    // so it must not be logged as a failure or retried in a tight loop.
    if (message && !/could not connect/i.test(message)) log(message);
    if (message && /could not connect/i.test(message)) client = null;
  });

  try {
    // No OAuth scopes: this is Rich Presence only (a presence card, not an
    // account action), so Discord skips the authorize step and emits `ready`
    // directly. login() with just the client id still performs the handshake
    // that names the pipe after our app id.
    void client.login({ clientId: clientId() }).catch(() => {
      client = null;
    });
  } catch (error) {
    log(`connect failed: ${error && error.message}`);
    client = null;
  }

  return client;
}

let lastState = { isPlaying: false, position: 0, duration: 0 };

// Unix ms, what discord-rpc expects. Discord draws the progress bar and the
// elapsed/total labels from these two alone, and animates the bar locally.
//
// Both playing and paused keep end at the real track end (start + duration),
// like Spotify: the bar freezes at the current position while the elapsed/total
// labels show the true numbers. Collapsing end to `now` made paused cards
// display total == position (01:26 / 01:26 on a 5:40 track).
function timestampsFor(state) {
  const positionMs = Math.max(0, Math.round((state.position || 0) * 1000));
  const now = Date.now();
  const start = now - positionMs;
  const durationMs = Math.max(0, Math.round((state.duration || 0) * 1000));
  return durationMs ? { start, end: start + durationMs } : { start };
}

const { coverUrlFor: resolvePublicCoverUrl } = require("./image-urls");

function coverUrl(song) {
  return resolvePublicCoverUrl(song);
}

// Buttons: Discord renders at most two, label + URL, and the URL MUST be
// http(s) — a custom scheme like streamify:// fails validation and takes the
// whole activity down with it. So the first button opens the showcase — the
// page a friend lands on when they tap your listening activity — and the
// second opens the track's own page on its original service when the track
// carries one.
const SHOWCASE_URL = (
  process.env.STREAMIFY_SHOWCASE_URL ||
  process.env.STREAMIFY_WEBPLAYER_URL ||
  "https://streamifyshowcase.vercel.app"
).replace(/\/+$/, "");

// Discord's Rich Presence schema has no button-color field — every app's
// buttons render the same dark gray pill, so "syncing with the theme" means
// matching Spotify's labels, not the color. First button opens the web
// player; second is a no-op placeholder until Discord whitelists activity-join
// (secrets can't coexist with URL buttons, so Listen Along ships disabled).
function buttonsFor(song) {
  const buttons = [{ label: "Listen on Streamify", url: SHOWCASE_URL }];
  const sourceUrl = song && typeof song.url === "string" ? song.url.trim() : "";
  if (/^https?:\/\//i.test(sourceUrl)) {
    buttons.push({ label: "Open Source", url: sourceUrl });
  }
  return buttons;
}

function activityFor(song, state) {
  const activity = {
    type: 2, // Listening — makes the card read "Listening to Streamify Desktop".
    details: song.title || "Unknown Track",
    state: song.artist || "Unknown Artist",
    largeImageKey: coverUrl(song) || undefined,
    largeImageText: song.title || undefined,
    // No small badge: "play"/"pause" are not uploaded assets for this Discord
    // app, and an unknown asset key silently renders nothing. The large cover
    // is the only image Spotify shows too.
    // Without instance:false Discord prefixes the state with "in Streamify
    // Desktop", which duplicates the header line.
    instance: false,
    buttons: buttonsFor(song),
    // Party + join secret: Discord renders "Ask to Join" from these natively
    // (the Spotify card's listen-along path). Off by default — see JOIN_ENABLED.
    ...(JOIN_ENABLED
      ? { partyId, partySize: 1, partyMax: 4, joinSecret, buttons: undefined }
      : {}),
    ...timestampsFor(state),
  };
  return activity;
}

async function send(activity, force = false) {
  if (!enabled()) return;
  // Rate limit: Discord allows one activity update per ~15s per client, and
  // spamming it gets the connection dropped. Key on everything that changes the
  // rendered card, so a normal play only sends one.
  const key = activity
    ? JSON.stringify([
        activity.details,
        activity.state,
        activity.largeImageKey,
        activity.start,
        activity.end,
      ])
    : "";
  if (!force && key === activityKey) return;
  activityKey = key;

  const target = rpcClient();
  if (!target) return;
  // The pipe is not open the instant login() resolves — the transport connects
  // asynchronously and emits `ready` when the handshake completes. Writing to a
  // null socket throws "Cannot read properties of null (reading 'write')", so
  // hold the activity until the transport is actually open.
  if (!clientReady) {
    pendingActivity = activity || {};
    return;
  }
  try {
    // discord-rpc 4.0.1 drops `type` from setActivity's payload, which makes
    // every card read "Playing ...". Sending SET_ACTIVITY directly keeps
    // type:2, so the card reads "Listening to Streamify Desktop" like
    // Spotify's does.
    await target.request("SET_ACTIVITY", {
      pid: process.pid,
      activity: {
        type: activity.type,
        state: activity.state,
        details: activity.details,
        timestamps: { start: activity.start, end: activity.end },
        assets: {
          large_image: activity.largeImageKey,
          large_text: activity.largeImageText,
        },
        ...(activity.partyId
          ? {
              party: { id: activity.partyId, size: [activity.partySize, activity.partyMax] },
              secrets: { join: activity.joinSecret },
            }
          : {}),
        buttons: activity.buttons,
        instance: activity.instance,
      },
    });
  } catch (error) {
    log(`setActivity failed: ${error && error.message}`);
    activityKey = "";
  }
}

function publish(song, state) {
  lastSong = song;
  lastState = {
    isPlaying: !!state?.isPlaying,
    isLoading: !!state?.isLoading,
    position: Number(state?.position) || 0,
    duration: Number(song?.duration) || Number(state?.duration) || 0,
  };
  void send(activityFor(song, lastState));
}

// Position ticks arrive ~1/s. Re-pinning the timestamps on each one would burn
// the 15s rate limit for a card Discord is already animating on its own, so the
// live position is tracked here and only used when something else forces a
// resend (pause, seek, track change, reconnect).
//
// A seek is the exception: the ticks jump by far more than a second's worth of
// playback, and Discord has no way to know — the card would keep showing the
// old elapsed time and the old bar position until the next track change. So a
// jump past the tolerance resends the timestamps, which re-pins the bar.
const SEEK_TOLERANCE_S = 3;

function publishPosition(seconds) {
  const next = Number(seconds) || 0;
  const previous = lastState.position;
  lastState.position = next;
  if (!lastSong || !lastState.isPlaying) return;
  if (Math.abs(next - previous) <= SEEK_TOLERANCE_S) return;
  void send(activityFor(lastSong, lastState), true);
}

function clear() {
  lastSong = null;
  const target = client;
  if (!target) return;
  activityKey = "";
  try {
    void target.clearActivity();
  } catch (error) {
    /* Discord is gone; nothing to clear. */
  }
}

let timer = null;

function wire() {
  if (!enabled()) {
    log("no client id set — presence disabled (set STREAMIFY_DISCORD_CLIENT_ID)");
    return;
  }
  if (timer) return;
  // Poll instead of connect-on-report: Discord may not be running yet, and a
  // presence that only appears on the next track change is useless. Cheap, and
  // it also recovers the client after a Discord restart.
  timer = setInterval(() => {
    if (client) return;
    rpcClient();
  }, RECONNECT_MS);
  log(`presence enabled (client id ${clientId()})`);
}

function dispose() {
  if (timer) clearInterval(timer);
  timer = null;
  clear();
  client = null;
  clientReady = false;
}

module.exports = {
  wire,
  publish,
  publishPosition,
  clear,
  dispose,
  setBootLog,
  enabled,
};