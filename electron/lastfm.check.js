// Self-check for Last.fm signing + scrobble rules. Run: node electron/lastfm.check.js
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Credentials must exist before the module reads them (it caches on first read).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lastfm-check-"));
process.env.STREAMIFY_LASTFM_DIR = dir;
fs.writeFileSync(
  path.join(dir, "lastfm.json"),
  JSON.stringify({
    apiKey: "test-key",
    apiSecret: "test-secret",
    sessionKey: "test-session",
    username: "tester",
  })
);

const lastfm = require("./lastfm");

// ---- signing ---------------------------------------------------------------
const secret = "test-secret";
const params = {
  api_key: "test-key",
  artist: "A",
  method: "track.scrobble",
  track: "T",
};
const expected = crypto
  .createHash("md5")
  .update("api_keytest-keyartistAmethodtrack.scrobbletrackT" + secret)
  .digest("hex");
assert.strictEqual(lastfm.sign(params, secret), expected, "md5(sorted name+value + secret)");
assert.strictEqual(
  lastfm.sign({ track: "T", method: "track.scrobble", artist: "A", api_key: "test-key" }, secret),
  expected,
  "key order must not matter"
);
assert.strictEqual(
  lastfm.sign({ ...params, format: "json", callback: "x" }, secret),
  expected,
  "format/callback are excluded from the signature"
);

// ---- scrobble threshold ----------------------------------------------------
assert.strictEqual(lastfm.scrobbleThreshold(29), null, "<30s never scrobbles");
assert.strictEqual(lastfm.scrobbleThreshold(30), 15, "50% of 30s");
assert.strictEqual(lastfm.scrobbleThreshold(60), 30, "50% of 60s");
assert.strictEqual(lastfm.scrobbleThreshold(480), 240, "50% of 480s = the 240s cap");
assert.strictEqual(lastfm.scrobbleThreshold(600), 240, "cap wins over 50%");
assert.strictEqual(lastfm.scrobbleThreshold(undefined), null, "unknown duration");
assert.strictEqual(lastfm.scrobbleThreshold(NaN), null, "NaN duration");
assert.strictEqual(lastfm.shouldScrobble(60, 29), false, "just under 50%");
assert.strictEqual(lastfm.shouldScrobble(60, 30), true, "at 50%");
assert.strictEqual(lastfm.shouldScrobble(1200, 239), false, "just under 240s");
assert.strictEqual(lastfm.shouldScrobble(1200, 240), true, "at 240s");
assert.strictEqual(lastfm.shouldScrobble(20, 500), false, "short track never scrobbles");

// ---- end to end against a stubbed transport -------------------------------
const calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(opts.body)) });
  return { json: async () => ({}) };
};
const methods = () => calls.filter((c) => c.body.method === "track.scrobble");
const nowPlayings = () => calls.filter((c) => c.body.method === "track.updateNowPlaying");
const trackOne = { id: "s1", title: "Song", artist: "Artist", album: "Album", duration: 120 };

lastfm.setEnabled(true);
const startedAt = Math.floor(Date.now() / 1000);
lastfm.onNowPlaying({ song: trackOne, isPlaying: true, position: 0 });

assert.strictEqual(calls.length, 1, "one updateNowPlaying on track start");
assert.strictEqual(calls[0].url, "https://ws.audioscrobbler.com/2.0/");
assert.strictEqual(calls[0].body.method, "track.updateNowPlaying");
assert.strictEqual(calls[0].body.artist, "Artist");
assert.strictEqual(calls[0].body.album, "Album");
assert.strictEqual(calls[0].body.duration, "120");
assert.strictEqual(calls[0].body.sk, "test-session");
const { format, api_sig, ...signedBody } = calls[0].body;
assert.strictEqual(format, "json", "format=json is sent");
assert.strictEqual(api_sig, lastfm.sign(signedBody, secret), "api_sig matches recomputed signature");

// 120s track -> threshold 60s.
for (let s = 1; s <= 59; s++) lastfm.onPosition(s);
assert.strictEqual(methods().length, 0, "no scrobble before 50%");
lastfm.onPosition(60);
assert.strictEqual(methods().length, 1, "scrobbles once at 50%");
assert.ok(
  methods()[0].body.timestamp >= startedAt && methods()[0].body.timestamp <= Math.floor(Date.now() / 1000),
  "timestamp = unix seconds at playback start"
);
assert.strictEqual(methods()[0].body.track, "Song");

// Keep listening: never a second scrobble for the same play.
for (let s = 61; s <= 119; s++) lastfm.onPosition(s);
assert.strictEqual(methods().length, 1, "never double-scrobble one play");
assert.strictEqual(nowPlayings().length, 1, "updateNowPlaying not resent on pause/resume");

// Pause flush: same id + isPlaying false keeps the play but settles it.
lastfm.onNowPlaying({ song: trackOne, isPlaying: false, position: 90 });
assert.strictEqual(methods().length, 1, "pause does not resubmit an already-scrobbled play");
lastfm.flush();
lastfm.flush();
assert.strictEqual(methods().length, 1, "flush is idempotent");

// Track change sends a fresh updateNowPlaying.
lastfm.onNowPlaying({ song: { id: "s2", title: "Two", artist: "B", duration: 45 }, isPlaying: true, position: 0 });
assert.strictEqual(nowPlayings().length, 2, "new track gets its own updateNowPlaying");

// Disabled: everything ignored.
lastfm.setEnabled(false);
lastfm.onNowPlaying({ song: { id: "s3", title: "Three", artist: "C", duration: 60 }, isPlaying: true, position: 0 });
lastfm.onPosition(60);
assert.strictEqual(nowPlayings().length, 2, "disabled -> no calls");
assert.strictEqual(methods().length, 1, "disabled -> no calls");

// Listened time only accumulates while isPlaying.
lastfm.setEnabled(true);
lastfm.onNowPlaying({ song: { id: "s4", title: "Four", artist: "D", duration: 60 }, isPlaying: false, position: 0 });
for (let s = 1; s <= 40; s++) lastfm.onPosition(s);
assert.strictEqual(methods().length, 1, "paused time does not count toward the threshold");
lastfm.onNowPlaying({ song: { id: "s4", title: "Four", artist: "D", duration: 60 }, isPlaying: true, position: 0 });
for (let s = 1; s <= 40; s++) lastfm.onPosition(s);
assert.strictEqual(methods().length, 2, "30s of playing reaches 50% of a 60s track");

fs.rmSync(dir, { recursive: true, force: true });
console.log("lastfm.check.js: all assertions passed");
