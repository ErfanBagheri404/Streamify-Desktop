// Windows SMTC (System Media Transport Controls) bridge.
//
// Electron never wires navigator.mediaSession to Windows' SMTC: the renderer
// can publish perfect metadata and Windows still reports zero media sessions —
// no volume overlay, no taskbar media panel, no lock-screen transport controls.
// Linux gets MPRIS (see wireMpris) and macOS gets this for free; Windows needs
// COM-level wiring through Windows.Media.SystemMediaTransportControls.
//
// nodert native addons are not an option: V8 headers require C++20, C++/CX
// (/ZW) is C++17-only, and MSVC refuses to compile both. So this module
// communicates over a named pipe to the standalone helper built from
// native/smtc/. The helper registers the SMTC session, mirrors pushed state and
// (like the app itself) has no view of the renderer — it only ever echoes what
// the main process tells it, and OS transport requests come back as JSON lines.
//
// Same contract as the MPRIS bridge: playback state lives in the renderer, this
// module only mirrors pushed state and forwards transport commands back over
// the shared `desktop:command` channel. Nothing re-implements playback.
const { app } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const { createServer, connect } = require("net");

// The helper is Windows-only. A missing binary or failed spawn must never take
// the app down — OS integration is a progressive enhancement.
let server = null;
let client = null;
let helper = null;
let pipeName = null;
let booted = false;
let bootLog = () => {};
let sendCommandRef = () => {};

function setBootLog(fn) {
  if (typeof fn === "function") bootLog = fn;
}

function setCommandSender(fn) {
  if (typeof fn === "function") sendCommandRef = fn;
}

function findHelper() {
  // Dev layout: native/smtc/bin/Release/net8.0-windows10.0.19041.0/win-x64/publish
  // Prod layout: resources/smtc-helper/ (electron-builder extraResources)
  const dev = path.join(
    app.getAppPath(),
    "native",
    "smtc",
    "bin",
    "Release",
    "net8.0-windows10.0.19041.0",
    "win-x64",
    "publish",
    "StreamifySmtcHelper.exe"
  );
  const prod = path.join(
    process.resourcesPath || app.getAppPath(),
    "smtc-helper",
    "StreamifySmtcHelper.exe"
  );
  try {
    if (require("fs").existsSync(dev)) return dev;
    if (require("fs").existsSync(prod)) return prod;
  } catch {}
  return null;
}

function startServer() {
  return new Promise((resolve, reject) => {
    pipeName = `streamify-smtc-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    server = createServer((socket) => {
      client = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line);
            if (message.type === "pong") return;
            // Only OS-side transport requests travel back. State mirrors do not.
            if (message.type === "button" && message.button) {
              sendCommandRef(message.button);
            }
          } catch {}
        }
      });
      socket.on("close", () => {
        if (client === socket) client = null;
      });
      socket.on("error", () => {});
      resolve(socket);
    });
    server.listen("\\\\.\\pipe\\" + pipeName, () => resolve(server));
    server.on("error", reject);
  });
}

function write(message) {
  if (!client || client.destroyed) return false;
  try {
    client.write(JSON.stringify(message) + "\n");
    return true;
  } catch {
    return false;
  }
}

function wire() {
  if (process.platform !== "win32") return;
  if (booted) return;
  booted = true;

  const exe = findHelper();
  if (!exe) {
    bootLog("[smtc] helper not found (skipping)");
    return;
  }

  void startServer()
    .then(() => {
      helper = spawn(exe, [pipeName, "Streamify Desktop"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      helper.stdout?.on("data", (d) => bootLog(`[smtc] helper: ${d}`.trimEnd()));
      helper.stderr?.on("data", (d) => bootLog(`[smtc] helper!: ${d}`.trimEnd()));
      helper.on("error", (error) => bootLog(`[smtc] spawn failed: ${error.message}`));
      helper.on("close", (code) => {
        bootLog(`[smtc] helper exited ${code}`);
        helper = null;
        client = null;
      });
    })
    .catch((error) => {
      bootLog(`[smtc] server failed: ${error.message}`);
    });
}

function clear() {
  write({ type: "clear" });
}

function publish(song, state) {
  // Shape it into the helper's expected payload. `state` here is the raw
  // renderer shape (flat booleans), not the { song, state } wrapper the
  // helper's protocol historically used — keep it consistent.
  write({
    type: "publish",
    song: {
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverUrl: song.coverUrl,
    },
    state: {
      isPlaying: !!state.isPlaying,
      hasNext: !!state.hasNext,
      hasPrevious: !!state.hasPrevious,
      position: Number(state.position) || 0,
      duration: Number(song.duration) || 0,
    },
  });
}

function publishPosition(seconds, duration) {
  write({ type: "position", seconds: Number(seconds) || 0, duration: Number(duration) || 0 });
}

function dispose() {
  clear();
  try {
    if (client) client.destroy();
    if (helper) helper.kill();
    if (server) server.close();
  } catch {}
  helper = null;
  client = null;
  server = null;
}

module.exports = {
  wire,
  publish,
  publishPosition,
  clear,
  dispose,
  setBootLog,
  setCommandSender,
  available: () => process.platform === "win32",
  loaded: () => booted,
};