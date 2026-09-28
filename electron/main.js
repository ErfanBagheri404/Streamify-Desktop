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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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

// The logo is an SVG, which nativeImage cannot decode — the tray and the
// window icon need a raster. dev/ uses the SVG (Chromium renders it for
// BrowserWindow), packaged builds get the 512px PNG electron-builder generated.
function iconPath() {
  if (app.isPackaged) {
    const png = path.join(ROOT, "icon.png");
    if (fs.existsSync(png)) return png;
  }
  return path.join(ROOT, "app", "public", "StreamifyLogo.svg");
}

// The tray glyph is transparent, so it sits on the OS chrome — that's the one
// icon that must be an alpha PNG, not the opaque installer tile.
function trayIcon() {
  const transparent = path.join(ROOT, "build", "icon-tray.png");
  const source = fs.existsSync(transparent) ? transparent : iconPath();
  const image = nativeImage.createFromPath(source);
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16, quality: "best" });
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
function createSplash() {
  mainWindow = new BrowserWindow({
    ...readBounds(),
    show: false,
    backgroundColor: "#000000",
    title: "Streamify",
    icon: iconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void mainWindow.loadFile(path.join(__dirname, "splash.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  return mainWindow;
}

function createWindow() {
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
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
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

  void mainWindow.loadURL(APP_ORIGIN);
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
  tray = new Tray(trayIcon());
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

  try {
    await startApi();
    startNext();
    await waitForHttp(`${APP_ORIGIN}/`);
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    const html = `<body style="background:#000;color:#eee;font:14px system-ui;padding:40px">
      <h2>Streamify failed to start</h2>
      <pre style="color:#f88;white-space:pre-wrap">${detail.replace(/</g, "&lt;")}</pre>
      </body>`;
    await splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    return;
  }

  splash.destroy();
  mainWindow = null;
  isBooting = false;
  bootLog("[boot] ready — opening main window");
  wireSelfUpdate();
  createWindow();
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
