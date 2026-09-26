// Electron main process - boots streamifyapi + Next.js, opens BrowserWindow
const { app, BrowserWindow, shell, Menu, globalShortcut, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const isDev = process.env.NODE_ENV !== "production";
const API_PORT = Number(process.env.STREAMIFY_API_PORT || 7861);
const APP_PORT = Number(process.env.STREAMIFY_APP_PORT || 3000);

let mainWindow = null;
let nextProc = null;
let apiProc = null;
let isQuitting = false;

// ---- single instance ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---- wait for a local http server ----
function waitForHttp(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve(true);
        })
        .on("error", () => {
          if (Date.now() > deadline) {
            reject(new Error(`Timed out waiting for ${url}`));
          } else {
            setTimeout(tryOnce, 250);
          }
        });
    };
    tryOnce();
  });
}

// ---- spawn a long-running child with transparent logs ----
function spawnChild(name, cmd, args, cwd, env) {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  proc.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
    if (!isQuitting && code !== 0) {
      app.quit();
    }
  });
  return proc;
}

// ---- boot children ----
async function startChildren() {
  apiProc = spawnChild(
    "api",
    "node",
    [isDev ? "scripts/dev-api.mjs" : path.join(__dirname, "..", "dist", "api-server.mjs")],
    path.join(__dirname, ".."),
    {
      STREAMIFY_API_PORT: String(API_PORT),
      ALLOWED_ORIGINS: `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`,
      WORKER_ENV: isDev ? "preview" : "production",
    }
  );

  const appDir = path.join(__dirname, "..", "app");
  nextProc = spawnChild(
    "next",
    "npm",
    [isDev ? "run" : "start", ...(isDev ? ["dev"] : [])],
    appDir,
    {
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(APP_PORT),
      STREAMIFY_API_PORT: String(API_PORT),
    }
  );

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${API_PORT}/health`),
    waitForHttp(`http://127.0.0.1:${APP_PORT}/`),
  ]);
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { role: "minimize" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        isDev && { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "reload" },
        { role: "togglefullscreen" },
      ].filter(Boolean),
    },
    {
      label: "Playback",
      submenu: [
        { label: "Play / Pause", accelerator: "MediaPlayPause", click: () => sendMediaKey("play-pause") },
        { label: "Next", accelerator: "MediaNextTrack", click: () => sendMediaKey("next") },
        { label: "Previous", accelerator: "MediaPreviousTrack", click: () => sendMediaKey("previous") },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Streamify Desktop",
          click: () => shell.openExternal("https://github.com/ErfanBagheri404/Streamify-Desktop"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendMediaKey(key) {
  if (mainWindow) mainWindow.webContents.send("media-key", key);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#000000",
    title: "Streamify Desktop",
    icon: path.join(__dirname, "..", "app", "public", "StreamifyLogo.svg"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    autoHideMenuBar: false,
  });

  mainWindow.setTitle("Streamify Desktop");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://localhost:${APP_PORT}`) && !url.startsWith(`http://127.0.0.1:${APP_PORT}`) && !url.startsWith(`https://hrlmsfsifdtvndrgpxth.supabase.co`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`http://localhost:${APP_PORT}`);

  // hide instead of close so music keeps playing
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  await app.whenReady();
  buildMenu();

  // media keys
  ["MediaPlayPause", "MediaNextTrack", "MediaPreviousTrack"].forEach((key) => {
    try {
      globalShortcut.register(key, () =>
        sendMediaKey(key === "MediaPlayPause" ? "play-pause" : key === "MediaNextTrack" ? "next" : "previous")
      );
    } catch {}
  });

  mainWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    backgroundColor: "#000000",
    webPreferences: { nodeIntegration: true },
  });
  mainWindow.loadFile(path.join(__dirname, "splash.html"));
  mainWindow.center();
  mainWindow.show();

  try {
    await startChildren();
  } catch (err) {
    console.error("Boot failed:", err);
  }

  if (mainWindow) {
    mainWindow.close();
    mainWindow = null;
  }
  createWindow();
}

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  if (nextProc && !nextProc.killed) nextProc.kill();
  if (apiProc && !apiProc.killed) apiProc.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
  isQuitting = true;
});

if (gotLock) {
  boot();
}
