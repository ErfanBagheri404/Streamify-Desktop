// Electron main process.
//
// The Streamify API runs IN THIS PROCESS (dynamic import of the esbuild bundle)
// — that is the whole point: no hosted-API round trip, no cold start, no added
// delay between the renderer and the backend.
//
// Next.js runs as a child process: it is a build server, not a request hot path,
// so a separate process costs nothing and keeps the main process simple.
const {
  app,
  BrowserWindow,
  shell,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const isProd = app.isPackaged || process.env.NODE_ENV === "production";
const isDev = !isProd;
// Self-update runs only in the packaged app: dev has no published release to
// compare against, and electron-updater would just error.
const canSelfUpdate = app.isPackaged;

// The renderer needs its own version to show "you are on X" in the update
// modal; the preload asks for it synchronously before the bridge is exposed.
ipcMain.on("desktop:app-info", (event) => {
  event.returnValue = { version: app.getVersion() };
});
const API_PORT = Number(process.env.STREAMIFY_API_PORT || 7861);
const APP_PORT = Number(process.env.STREAMIFY_APP_PORT || 3000);
// The renderer talks to localhost (matches NEXT_PUBLIC_SITE_URL and the
// Supabase redirect allowlist), the in-process API to 127.0.0.1 (never exposed).
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
// Packaged layout: electron-builder puts the Next app and the API bundle under
// resources/ (asar-unpacked — Next needs real fs), the main process inside asar.
const ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");

let mainWindow = null;
let nextProc = null;
let apiServer = null;
let tray = null;
let isQuitting = false;
// window-all-closed fires when the splash is destroyed mid-boot, which would
// quit the app before the real window exists.
let isBooting = true;

// ---- single instance -------------------------------------------------------
// The streamify-desktop://auth?grant&state deep link can only arrive on the
// second process (single-instance lock), so the second-instance handler also
// routes deep-link URLs back into this instance. argv parsing covers both
// packaged (argv[1]) and dev (`electron . <url>`, argv[last]) launches.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = Array.isArray(argv) ? argv.find((arg) => typeof arg === "string" && arg.startsWith(`${AUTH_SCHEME}://`)) : null;
    if (deepLink) handleDeepLink(deepLink);
    showWindow();
  });
}

// ---- helpers ---------------------------------------------------------------
function waitForHttp(url, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(tryOnce, 300);
      });
      req.setTimeout(5000, () => req.destroy());
    };
    tryOnce();
  });
}

// The logo is an SVG, which nativeImage cannot decode. BrowserWindow's `icon`
// and the tray both need a real raster, so both use the rendered PNGs in
// build/. Resolve through __dirname, not ROOT: in a packaged build the files
// live inside app.asar/... while ROOT points at process.resourcesPath, so a
// ROOT-relative lookup silently misses and falls through to the SVG (which
// nativeImage rejects -> empty icon).
function iconPath() {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(ROOT, "build", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(__dirname, "..", "app", "public", "StreamifyLogo.svg");
}

// The tray glyph is transparent, so it sits on the OS chrome — that's the one
// icon that must be an alpha PNG, not the opaque installer tile.
function trayIcon() {
  const candidates = [
    path.join(__dirname, "..", "build", "icon-tray.png"),
    path.join(ROOT, "build", "icon-tray.png"),
  ];
  const source = candidates.find((c) => fs.existsSync(c)) || iconPath();
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) {
    bootLog(`[tray] icon failed to load: ${source}`);
    return nativeImage.createEmpty();
  }
  return image.resize({ width: 16, height: 16, quality: "best" });
}

// Windows GUI-subsystem Electron binaries lose stdout when spawned detached, so
// mirror every boot message into a log file we can read back.
function bootLog(line) {
  const stamp = new Date().toISOString();
  process.stdout.write(`${stamp} ${line}\n`);
  try {
    const dir = path.join(ROOT, ".logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "app.log"), `${stamp} ${line}\n`);
  } catch {}
}

function isLocalUrl(url) {
  return (
    url.startsWith(APP_ORIGIN) ||
    url.startsWith(`http://127.0.0.1:${APP_PORT}`)
  );
}

function boundsFile() {
  return path.join(app.getPath("userData"), "window-bounds.json");
}

function readBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch {}
  return { width: 1280, height: 820 };
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify(mainWindow.getNormalBounds()));
  } catch {}
}

// ---- desktop auth handoff (browser-mediated device grant) ------------------
// The desktop never collects credentials. beginDesktopAuth() creates a PKCE
// challenge + nonce, opens the webplayer confirm page in the OS browser, and
// the webplayer hands a short-lived signed grant back via
// streamify-desktop://auth?grant&state. The verifier never leaves this
// process until the redeem call below; no token ever appears in a URL.
const AUTH_SCHEME = "streamify-desktop";
const WEBPLAYER_ORIGIN = (process.env.STREAMIFY_WEBPLAYER_URL || "https://streamify-player.vercel.app").replace(/\/+$/, "");
const AUTH_PENDING_TTL_MS = 5 * 60 * 1000;
// state -> { verifier, nonce, expiresAt }
const authPending = new Map();
// Last successful redeem, kept until a renderer claims it. Guards the race
// where the deep link lands before the window's listener is attached.
let pendingAuthResult = null;

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pruneAuthPending() {
  const now = Date.now();
  for (const [state, entry] of authPending) {
    if (entry.expiresAt <= now) authPending.delete(state);
  }
}

// constant-time compare so a local observer can't learn the nonce bytewise.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

// Hardened deep-link parse: validate scheme, require grant+state, reject
// anything malformed (unknown host, extra params still fine — ignore them).
function parseDeepLink(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${AUTH_SCHEME}:`) return null;
  if (parsed.host !== "auth") return null;
  const grant = parsed.searchParams.get("grant");
  const state = parsed.searchParams.get("state");
  if (!grant || !state) return null;
  return { grant, state };
}

function emitAuthError(message) {
  send("desktop:auth-error", { message });
  showWindow();
}

async function redeemGrant(grant, entry) {
  let response;
  try {
    response = await fetch(`${WEBPLAYER_ORIGIN}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant, verifier: entry.verifier }),
    });
  } catch (error) {
    emitAuthError(`Could not reach the sign-in service: ${error && error.message ? error.message : error}`);
    return;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok || !payload || typeof payload.token_hash !== "string") {
    emitAuthError(
      (payload && typeof payload.error === "string" && payload.error) ||
        `Sign-in failed (status ${response.status}).`
    );
    return;
  }
  // Bind the response to this app instance: the nonce echoed through the
  // browser must match what we generated, compared constant-time.
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  if (!nonce || !safeEqual(nonce, entry.nonce)) {
    emitAuthError("Sign-in response did not match this device. Please try again.");
    return;
  }
  const result = {
    token_hash: payload.token_hash,
    type: typeof payload.type === "string" ? payload.type : "magiclink",
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
  // The renderer may not have its listener attached yet (window reloading, user
  // on another route, or the app was just launched by the deep link), so the
  // result is buffered as well as pushed. The renderer claims it via
  // desktop:auth-take if the push was missed. Whichever path runs first wins.
  pendingAuthResult = result;
  bootLog(`[auth] grant redeemed ok email=${result.email || "unknown"}`);
  send("desktop:auth-result", result);
  showWindow();
}

function handleDeepLink(rawUrl) {
  const parsed = parseDeepLink(rawUrl);
  if (!parsed) {
    bootLog(`[auth] ignoring malformed deep link: ${String(rawUrl).slice(0, 80)}`);
    return;
  }
  pruneAuthPending();
  const entry = authPending.get(parsed.state);
  if (!entry) {
    emitAuthError("This sign-in link expired or belongs to another session. Please try again.");
    return;
  }
  authPending.delete(parsed.state);
  if (entry.expiresAt <= Date.now()) {
    emitAuthError("This sign-in attempt expired. Please try again.");
    return;
  }
  void redeemGrant(parsed.grant, entry);
}

function beginDesktopAuth() {
  const crypto = require("crypto");
  pruneAuthPending();
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const nonce = base64url(crypto.randomBytes(16));
  const state = base64url(crypto.randomBytes(16));
  authPending.set(state, { verifier, nonce, expiresAt: Date.now() + AUTH_PENDING_TTL_MS });
  // Cap the pending map so abandoned attempts can't grow it unboundedly.
  if (authPending.size > 20) {
    const oldest = authPending.keys().next();
    if (!oldest.done) authPending.delete(oldest.value);
  }
  const url = new URL("/auth/desktop", WEBPLAYER_ORIGIN);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  void shell.openExternal(url.toString());
  return { state };
}

ipcMain.on("desktop:auth-start", (event) => {
  try {
    event.returnValue = { ok: true, ...beginDesktopAuth() };
  } catch (error) {
    event.returnValue = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

// Claim a redeem result that the push missed (listener not attached yet).
// Reading clears it, so a result is still delivered exactly once.
ipcMain.on("desktop:auth-take", (event) => {
  event.returnValue = pendingAuthResult;
  pendingAuthResult = null;
});

// macOS delivers custom-protocol URLs here. Windows/Linux deliver them via
// second-instance argv (handled above). First-launch cold start on any OS can
// also carry the URL in process.argv, handled in boot().
if (process.platform === "darwin") {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
}

function registerAuthProtocol() {
  // Dev: `electron .` needs the explicit exe path + args so the OS can route
  // the URL back into this process. Packaged: plain registration is enough.
  const ok = isDev
    ? app.setAsDefaultProtocolClient(AUTH_SCHEME, process.execPath, [path.resolve(process.argv[1] || ".")])
    : app.setAsDefaultProtocolClient(AUTH_SCHEME);
  bootLog(`[auth] protocol ${AUTH_SCHEME}:// registered=${ok}`);
}

// ---- in-process API --------------------------------------------------------
async function startApi() {
  // Packaged: main.js lives at app.asar/electron/main.js, so the bundle is at
  // app.asar/dist/api-server.mjs (dynamic import works from inside asar).
  // Dev: plain path under the repo root.
  const bundle = app.isPackaged
    ? path.join(__dirname, "..", "dist", "api-server.mjs")
    : path.join(ROOT, "dist", "api-server.mjs");
  if (!fs.existsSync(bundle)) {
    throw new Error(`Missing ${bundle} — run "npm run build:api" first.`);
  }

  process.env.STREAMIFY_API_PORT = String(API_PORT);
  process.env.STREAMIFY_API_STANDALONE = "0"; // we call startApiServer() ourselves
  process.env.ALLOWED_ORIGINS = `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`;
  if (!process.env.WORKER_ENV) process.env.WORKER_ENV = isDev ? "preview" : "production";

  bootLog(`[api:import] loading ${bundle}`);
  const mod = await import(pathToFileURL(bundle).href);
  bootLog(`[api:import] done, startApiServer=${typeof mod.startApiServer}`);
  apiServer = await mod.startApiServer(API_PORT);
  bootLog(`[api:started] port=${apiServer.port}`);
}

// ---- Next child process ----------------------------------------------------
function startNext() {
  const appDir = path.join(ROOT, "app");

  // No --hostname: Next then binds all interfaces, so both `localhost` (IPv6,
  // what the renderer and the Supabase redirect allowlist use) and `127.0.0.1`
  // (IPv4, what scripts use) resolve. `--hostname localhost` binds ::1 only.
  //
  // Production runs the standalone server (Next `output: "standalone"`), so the
  // packaged app ships no node_modules. Dev keeps the `next dev` CLI.
  // Both run under ELECTRON_RUN_AS_NODE, so no system Node is needed either.
  //
  // The two layouts differ: the repo keeps standalone at
  // app/.next/standalone/server.js, while electron-builder flattens it to
  // resources/app/server.js (see package.json extraResources). So pick by
  // mode, not by sniffing — sniffing would also make dev silently serve the
  // stale standalone build instead of hot-reloading.
  const standaloneDir = app.isPackaged
    ? appDir
    : path.join(appDir, ".next", "standalone");
  const standaloneServer = path.join(standaloneDir, "server.js");
  const isStandalone = fs.existsSync(standaloneServer);
  const args = isStandalone
    ? [standaloneServer]
    : [
        path.join(appDir, "node_modules", "next", "dist", "bin", "next"),
        // `next dev` needs the webpack flag (Next 16 defaults to turbopack);
        // the standalone server needs no bundler flag at all.
        "dev",
        "--webpack",
        "--port",
        String(APP_PORT),
      ];

  nextProc = spawn(process.execPath, args, {
      cwd: isStandalone ? standaloneDir : appDir,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: String(APP_PORT),
        HOSTNAME: "0.0.0.0",
        STREAMIFY_API_PORT: String(API_PORT),
        // Without this the Electron binary runs the script as another Electron
        // app instead of plain node — the packaged build needs no system Node.
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  nextProc.stdout.on("data", (d) => bootLog(`[next] ${d}`));
  nextProc.stderr.on("data", (d) => bootLog(`[next:err] ${d}`));
  nextProc.on("error", (e) => bootLog(`[next:spawn-error] ${e.message}`));
  nextProc.on("exit", (code, signal) => {
    bootLog(`[next:exit] code=${code} signal=${signal} quitting=${isQuitting}`);
  });
  bootLog(`[next:spawn] ${process.execPath} ${args.join(" ")} standalone=${isStandalone} port=${APP_PORT}`);
  return nextProc;
}

// ---- window ----------------------------------------------------------------
// The boot splash and the app share ONE window. Building a second window and
// destroying the first makes the taskbar entry disappear and reappear, which
// reads as the app closing and reopening mid-boot.
function splashUrl() {
  return "file://" + path.join(__dirname, "splash.html").replace(/\\/g, "/");
}

function failureHtml(detail) {
  return `<body style="background:#000;color:#eee;font:14px system-ui;padding:40px">
      <h2>Streamify failed to start</h2>
      <pre style="color:#f88;white-space:pre-wrap">${detail.replace(/</g, "&lt;")}</pre>
      </body>`;
}

function createSplash() {
  return createWindow({ splash: true });
}

function createWindow({ splash = false } = {}) {
  mainWindow = new BrowserWindow({
    ...readBounds(),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#000000",
    title: "Streamify Desktop",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    // Stay in-app for our own routes and the Supabase auth round trip; anything
    // else belongs to the OS browser.
    if (isLocalUrl(url) || url.startsWith("https://hrlmsfsifdtvndrgpxth.supabase.co")) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    // Splash/failure docs (file://, data:) load in this same window during
    // boot — the app server isn't up yet, so the link must wait for the real
    // app document. Only http(s) counts.
    if (!mainWindow.webContents.getURL().startsWith("http")) return;
    // Cold start: a streamify-desktop:// URL may sit in process.argv (Windows
    // and Linux launch the app with the link when nothing is running). The
    // pending map only exists in this process, so honouring it on first load is
    // what makes the handoff work when the app was closed.
    const coldStartLink = process.argv.find(
      (arg) => typeof arg === "string" && arg.startsWith(`${AUTH_SCHEME}://`)
    );
    if (coldStartLink) {
      process.argv.splice(process.argv.indexOf(coldStartLink), 1);
      handleDeepLink(coldStartLink);
    }
  });

  // Hide instead of quit so playback survives closing the window.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      persistBounds();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(splash ? splashUrl() : APP_ORIGIN);
  if (splash) mainWindow.once("ready-to-show", () => mainWindow?.show());
  return mainWindow;
}

// ---- desktop OS integration (Now Playing notification + Linux MPRIS) -------
// The renderer owns playback; it pushes state here and the OS surfaces it.
// Commands coming back (tray, menu, media keys, MPRIS) are forwarded to the
// renderer over the same channel.
const integration = require("./integration");
integration.setIntegrationHooks({ showWindow, sendCommand, bootLog });

// The renderer reports the track it just started (or stopped) so the OS can
// show a Now Playing notification and update the MPRIS metadata.
ipcMain.on(
  "desktop:now-playing",
  (_event, payload) => {
    const song = payload?.song || null;
    const state = {
      isPlaying: !!payload?.isPlaying,
      hasNext: !!payload?.hasNext,
      hasPrevious: !!payload?.hasPrevious,
      position: Number(payload?.position) || 0,
    };
    if (song && payload?.notify !== false) {
      void integration.showNowPlaying(song, state);
    } else if (!song) {
      integration.clearNowPlaying();
    }
    integration.publishMpris(song, state);
  }
);

// Position updates are high-frequency; MPRIS only needs the latest one, and
// the notification never cares, so this is fire-and-forget.
ipcMain.on("desktop:position", (_event, seconds) => {
  integration.publishMprisPosition(Number(seconds) || 0);
});

// ---- menu + media keys + tray ---------------------------------------------
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendCommand(command, payload) {
  const normalized = {
    command: typeof command === "string" ? command : command?.command,
    payload: payload ?? (typeof command === "object" ? command?.payload : undefined),
  };
  send("desktop:command", normalized);
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Show Window", accelerator: "CmdOrCtrl+Shift+S", click: () => showWindow() },
        { type: "separator" },
        { role: "quit", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      label: "View",
      submenu: [
        isDev ? { role: "toggleDevTools" } : null,
        isDev ? { type: "separator" } : null,
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ].filter(Boolean),
    },
    {
      label: "Playback",
      submenu: [
        { label: "Play / Pause", accelerator: "MediaPlayPause", click: () => sendCommand("play-pause") },
        { label: "Next", accelerator: "MediaNextTrack", click: () => sendCommand("next") },
        { label: "Previous", accelerator: "MediaPreviousTrack", click: () => sendCommand("previous") },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Streamify Desktop",
          click: () => void shell.openExternal("https://github.com/ErfanBagheri404/Streamify-Desktop"),
        },
        {
          label: "Check for updates",
          click: () => triggerUpdateCheck("menu"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---- self-update (electron-updater, GitHub releases feed) -------------------
// The modal lives in the renderer (UpdateModal.tsx); main only shuttles
// electron-updater events over IPC. autoDownload is off on purpose: the user
// sees the new version first and explicitly clicks Update. The installer/portable
// trade-off is inherited from electron-updater: NSIS updates silently, portable
// downloads the new exe, everything else (dmg/zip/deb/AppImage) notifies and
// links the release page.
let updateDownloadedVersion = null;
// Held at module scope so the app menu and the tray can trigger a check
// without going through a renderer round trip.
let updaterRef = null;

function triggerUpdateCheck(source = "menu") {
  if (!canSelfUpdate || !updaterRef) return;
  bootLog(`[update] check requested from ${source}`);
  void updaterRef.checkForUpdates();
}

function forwardUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function wireSelfUpdate() {
  if (!canSelfUpdate) return;
  let updater;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
    updaterRef = updater;
  } catch (error) {
    bootLog(`[update] electron-updater unavailable: ${error && error.message}`);
    return;
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on("update-available", (info) => {
    bootLog(`[update] available ${info && info.version}`);
    forwardUpdate("desktop:update-available", {
      version: info && info.version,
      releaseDate: info && info.releaseDate,
      releaseNotes: releaseNotesText(info),
    });
  });
  updater.on("update-not-available", () => {
    forwardUpdate("desktop:update-not-available");
  });
  updater.on("download-progress", (progress) => {
    forwardUpdate("desktop:update-progress", {
      percent: progress && progress.percent,
      transferred: progress && progress.transferred,
      total: progress && progress.total,
    });
  });
  updater.on("update-downloaded", (info) => {
    updateDownloadedVersion = (info && info.version) || null;
    bootLog(`[update] downloaded ${updateDownloadedVersion}`);
    forwardUpdate("desktop:update-downloaded", { version: updateDownloadedVersion });
  });
  updater.on("error", (error) => {
    bootLog(`[update] error ${error && error.message}`);
    forwardUpdate("desktop:update-error", { message: (error && error.message) || "update failed" });
  });

  ipcMain.on("desktop:update-check", () => triggerUpdateCheck("renderer"));
  ipcMain.on("desktop:update-download", () => {
    if (!canSelfUpdate) return;
    bootLog("[update] user started download");
    void updater.downloadUpdate();
  });
  ipcMain.on("desktop:update-install", () => {
    if (!canSelfUpdate || !updateDownloadedVersion) return;
    bootLog("[update] user confirmed install — quitting to update");
    isQuitting = true;
    updater.quitAndInstall(false, true);
  });

  // One silent check shortly after boot; the user still explicitly clicks
  // Update in the modal before anything downloads or installs.
  setTimeout(() => {
    bootLog("[update] scheduled check");
    void updater.checkForUpdates();
  }, 15000);
}

function releaseNotesText(info) {
  if (!info) return null;
  const notes = info.releaseNotes;
  if (!notes) return null;
  if (typeof notes === "string") return notes.slice(0, 2000);
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => (entry && entry.note ? String(entry.note) : ""))
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 2000);
  }
  return null;
}

// Closing the window hides it instead of quitting (playback survives), so the
// tray is the only way back for users who don't know the shortcut.
function createTray() {
  const icon = trayIcon();
  // Empty means nativeImage rejected the file (e.g. an SVG slipped through) —
  // the tray would silently render nothing, so make it loud in the boot log.
  bootLog(`[tray] icon ok — ${!icon.isEmpty()} from ${icon.getSize().width}x${icon.getSize().height}`);
  tray = new Tray(icon);
  tray.setToolTip("Streamify Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Streamify", click: () => showWindow() },
      { type: "separator" },
      { label: "Next track", click: () => sendCommand("next") },
      { label: "Previous track", click: () => sendCommand("previous") },
      { label: "Play / pause", click: () => sendCommand("play-pause") },
      { type: "separator" },
      {
        label: "Check for updates",
        click: () => triggerUpdateCheck("tray"),
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => showWindow());
}

// The app owns its own theme (SettingsContext writes data-theme); the native
// frame, tray and dialogs should follow it instead of being pinned to dark.
ipcMain.on("desktop:theme", (_event, theme) => {
  const light =
    theme === "light" ||
    (theme !== "dark" && nativeTheme.shouldUseDarkColors === false);
  nativeTheme.themeSource = light ? "light" : "dark";
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(light ? "#ffffff" : "#000000");
  }
});

// Dev-only: remote debugging port so the UI can be driven and inspected.
// commandLine switches must be set before the app is ready; the env var is
// only ever set by a developer's shell, never in a packaged build.
if (process.env.STREAMIFY_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.STREAMIFY_DEBUG_PORT);
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  await app.whenReady();
  bootLog(`[boot] app-ready dev=${isDev} apiPort=${API_PORT} appPort=${APP_PORT}`);
  nativeTheme.themeSource = "dark";
  registerAuthProtocol();
  buildMenu();
  createTray();
  integration.wireMpris();

  for (const [key, action] of [
    ["MediaPlayPause", "play-pause"],
    ["MediaNextTrack", "next"],
    ["MediaPreviousTrack", "previous"],
  ]) {
    try {
      globalShortcut.register(key, () => sendCommand(action));
    } catch {}
  }

  // Dev-only: remote debugging port so the UI can be driven and inspected.
  // Never set in a packaged build (kept only as a reminder of the switch name).

  const splash = createSplash();
  bootLog(`[boot] splash in window #${splash.id} (windows=${BrowserWindow.getAllWindows().length})`);

  try {
    await startApi();
    startNext();
    await waitForHttp(`${APP_ORIGIN}/`);
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    await splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(failureHtml(detail)));
    return;
  }

  // Same window: swap the splash document for the app. Destroying and
  // rebuilding made the taskbar entry blink out and back.
  await mainWindow.loadURL(APP_ORIGIN);
  isBooting = false;
  bootLog(`[boot] ready — opening main window #${mainWindow.id} (windows=${BrowserWindow.getAllWindows().length})`);
  wireSelfUpdate();
}

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  persistBounds();
  Promise.resolve(apiServer?.close?.()).catch(() => {});
  if (nextProc && !nextProc.killed) nextProc.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (isBooting) return;
  if (process.platform !== "darwin") app.quit();
});

if (gotLock) {
  void boot();
}
