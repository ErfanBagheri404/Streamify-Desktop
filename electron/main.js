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
  globalShortcut,
  nativeTheme,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const isDev = process.env.NODE_ENV !== "production";
const API_PORT = Number(process.env.STREAMIFY_API_PORT || 7861);
const APP_PORT = Number(process.env.STREAMIFY_APP_PORT || 3000);
// The renderer talks to localhost (matches NEXT_PUBLIC_SITE_URL and the
// Supabase redirect allowlist), the in-process API to 127.0.0.1 (never exposed).
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const ROOT = path.join(__dirname, "..");

let mainWindow = null;
let nextProc = null;
let apiServer = null;
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

function iconPath() {
  return path.join(ROOT, "app", "public", "StreamifyLogo.svg");
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
  const bundle = path.join(ROOT, "dist", "api-server.mjs");
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
  const nextBin = path.join(appDir, "node_modules", "next", "dist", "bin", "next");

  nextProc = spawn(
    process.execPath,
    [nextBin, isDev ? "dev" : "start", "--webpack", "--hostname", "localhost", "--port", String(APP_PORT)],
    {
      cwd: appDir,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: String(APP_PORT),
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
  bootLog(`[next:spawn] ${process.execPath} ${nextBin} dev=${isDev} port=${APP_PORT}`);
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

// ---- menu + media keys -----------------------------------------------------
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Show Window", accelerator: "CmdOrCtrl+Shift+S", click: () => mainWindow?.show() },
        { type: "separator" },
        { role: "quit", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      label: "View",
      submenu: [
        isDev ? { role: "toggleDevTools" } : null,
        { type: "separator" },
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
        { label: "Play / Pause", accelerator: "MediaPlayPause", click: () => send("media-key", "play-pause") },
        { label: "Next", accelerator: "MediaNextTrack", click: () => send("media-key", "next") },
        { label: "Previous", accelerator: "MediaPreviousTrack", click: () => send("media-key", "previous") },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Streamify Desktop",
          click: () => void shell.openExternal("https://github.com/ErfanBagheri404/Streamify-Desktop"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  await app.whenReady();
  bootLog(`[boot] app-ready dev=${isDev} apiPort=${API_PORT} appPort=${APP_PORT}`);
  nativeTheme.themeSource = "dark";
  buildMenu();

  for (const key of ["MediaPlayPause", "MediaNextTrack", "MediaPreviousTrack"]) {
    const action =
      key === "MediaPlayPause" ? "play-pause" : key === "MediaNextTrack" ? "next" : "previous";
    try {
      globalShortcut.register(key, () => send("media-key", action));
    } catch {}
  }

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
