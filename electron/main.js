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
let proxyRestartInFlight = false;
let apiServer = null;
let tray = null;
let isQuitting = false;
// window-all-closed fires when the splash is destroyed mid-boot, which would
// quit the app before the real window exists.
let isBooting = true;
// One-shot: the boot splash entry is dropped from history the first time a
// real http app document finishes loading.
let splashHistoryCleared = false;

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

// ---- proxy ------------------------------------------------------------------
// The Next child is plain Node and cannot read the Windows proxy settings, so
// the mode is resolved here and handed over as env (see resolveProxyUrl +
// instrumentation.ts). Chromium gets the same value through setProxy, so the
// renderer and the server always agree.
const PROXY_MODES = ["system", "manual", "off"];

// Height of the OS caption-button box. Deliberately 4px shorter than the
// in-window strip (MENU_BAR_HEIGHT = 36) so the strip's bottom divider stays
// visible underneath the buttons instead of running into them.
const CAPTION_BUTTON_HEIGHT = 32;

function proxyFile() {
  return path.join(app.getPath("userData"), "proxy.json");
}

function readProxyConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(proxyFile(), "utf8"));
    const mode = PROXY_MODES.includes(saved?.mode) ? saved.mode : "system";
    const url = typeof saved?.url === "string" ? saved.url.trim() : "";
    return { mode, url };
  } catch {
    return { mode: "system", url: "" };
  }
}

function writeProxyConfig(config) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(proxyFile(), JSON.stringify(config));
  } catch {}
}

// A bare "host:port" is what people paste, so accept it and assume http://.
function normalizeProxyUrl(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

// "off" must bypass the system settings too, so it maps to "direct://" rather
// than "system://" — Chromium's proxy rules treat direct:// as always-direct.
function proxyRulesFor(config) {
  if (config.mode === "off") return "direct://";
  if (config.mode === "manual") {
    const url = normalizeProxyUrl(config.url);
    return url ? url : "direct://";
  }
  return "system://";
}

// Hosts that must NOT go through the proxy. Measured on this network: the local
// proxy (xray) reaches YouTube but cannot reach Supabase at all (20s timeout),
// while Supabase answers directly in ~0.4s. Routing everything through the
// proxy therefore broke sign-in even though covers worked.
const PROXY_BYPASS_HOSTS = [
  "hrlmsfsifdtvndrgpxth.supabase.co",
  "supabase.co",
  "supabase.in",
  "supabase.com",
  "streamify-player.vercel.app",
  "vercel.app",
  "localhost",
  "127.0.0.1",
  "[::1]",
];

function proxyBypassRules() {
  return PROXY_BYPASS_HOSTS.map((h) => `*${h}*`).join(",");
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
// Chromium resolves the system proxy for the renderer, but the Next child is
// plain Node (undici) and ignores it — so resolve the proxy here and hand it
// over as env. instrumentation.ts turns that into a global proxy dispatcher.
// Without this the Supabase auth handoff fails with ENOTFOUND / Failed to
// fetch whenever a system proxy is set or local DNS is unreliable.
async function resolveProxyUrl() {
  const config = readProxyConfig();

  if (config.mode === "off") {
    bootLog("[proxy] disabled by setting");
    return null;
  }
  if (config.mode === "manual") {
    const url = normalizeProxyUrl(config.url);
    bootLog(`[proxy] manual -> ${url || "(empty, direct)"}`);
    return url || null;
  }

  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    // Probe a host that is NOT in PROXY_BYPASS_HOSTS. Asking about Supabase
    // always answered "direct://" (it is bypassed on purpose), so system mode
    // silently handed the Next child no proxy at all — and every
    // SoundCloud/YouTube fetch then failed with "Failed to fetch". Probe a
    // host we actually want proxied.
    const resolved = await mainWindow.webContents.session.resolveProxy(
      "https://api-v2.soundcloud.com"
    );
    const match = /^(PROXY|SOCKS5?|HTTPS?)\s+(\S+)/i.exec(resolved || "");
    if (!match) {
      // Worth saying out loud: system mode + OS proxy disabled = direct, and
      // direct cannot reach SoundCloud from this region.
      bootLog(`[proxy] system mode resolved '${resolved || "empty"}' -> direct (no proxy)`);
      return null;
    }
    const host = match[2];
    const scheme = /^socks/i.test(match[1]) ? "socks5" : "http";
    const url = `${scheme}://${host}`;
    bootLog(`[proxy] system proxy for supabase -> ${url}`);
    return url;
  } catch (error) {
    bootLog(`[proxy] resolveProxy failed: ${error?.message || error}`);
    return null;
  }
}

// Resolved once at boot (after the window exists so resolveProxy works) and
// shared: the Next child gets it as env, the in-process API installs it as a
// dispatcher, and it is re-read after relaunch.
let bootProxyUrl = null;

async function startNext() {
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

  // Chromium resolves the system proxy for the renderer, but the Next child
  // is plain Node (undici) and ignores it — so hand it the resolved proxy URL
  // explicitly. instrumentation.ts turns that into a global proxy dispatcher.
  // Without this the Supabase auth handoff fails with ENOTFOUND/Failed to
  // fetch whenever a system proxy is set or local DNS is unreliable.
  const proxyUrl = bootProxyUrl;

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
      ...(proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : {}),
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
    // The native title bar is tinted by the Windows accent color, so it is
    // hidden and the caption buttons are drawn by the overlay instead. The
    // overlay colour is re-painted on theme change (see applyTheme) to match
    // the in-window strip, otherwise the two read as different materials.
    titleBarStyle: "hidden",
    // The OS draws its caption buttons inside a box of exactly this height, and
    // the strip's divider sits on its last row — at 36px the buttons would end
    // flush with the border and look like they were painted over it. 4px short
    // of the 36px strip (MENU_BAR_HEIGHT) leaves the divider clear underneath.
    titleBarOverlay: { color: "#050505", symbolColor: "#e3e3e3", height: CAPTION_BUTTON_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Same proxy the Next child gets, so the renderer never disagrees with the
  // server about how to reach the network.
  try {
    const config = readProxyConfig();
    const rules = proxyRulesFor(config);
    mainWindow.webContents.session.setProxy({
      proxyRules: rules,
      // localhost is the app itself and the in-process API; proxying it would
      // loop the renderer's own requests back through the proxy. Auth hosts
      // bypass too: measured, the local proxy cannot reach Supabase (20s
      // timeout) while direct answers in ~0.4s.
      proxyBypassRules: proxyBypassRules(),
    });
    bootLog(`[proxy] renderer rules=${rules} bypass=${proxyBypassRules()}`);
  } catch (error) {
    bootLog(`[proxy] setProxy failed: ${error?.message || error}`);
  }

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

  // Renderer errors never reach stdout, so a failed sign-in used to be
  // invisible from the outside. Forward console errors (they carry the
  // supabase-js failure detail) into the app log.
  mainWindow.webContents.on("console-message", (_event, details) => {
    const level = typeof details?.level === "string" ? details.level : "";
    if (level !== "error" && level !== "warning") return;
    const message = String(details?.message || "").trim();
    if (!message) return;
    bootLog(`[renderer:${level}] ${message.slice(0, 300)}`);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    // Splash/failure docs (file://, data:) load in this same window during
    // boot — the app server isn't up yet, so the link must wait for the real
    // app document. Only http(s) counts.
    if (!mainWindow.webContents.getURL().startsWith("http")) return;
    // The splash document is the previous history entry, so the overlay's Back
    // chevron would walk back into a dead boot screen. Drop it once, as soon as
    // the real app document is up (doing it right after loadURL races the
    // navigation and gets discarded).
    if (!splashHistoryCleared) {
      splashHistoryCleared = true;
      mainWindow.webContents.navigationHistory.clear();
    }
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

// ---- in-window overlay title bar -------------------------------------------
// The native title bar is hidden (titleBarStyle: "hidden") and the old menu
// bar row is gone, so the app draws its own strip INSIDE the window, on top of
// the content: dots menu + back/forward on the left, OS caption buttons on the
// right. main only serves the two commands the renderer can't do itself.

// Pops the existing application menu. No coordinates: the mouse cursor is
// already on the dots button when this arrives, and menu.popup defaults to the
// cursor position — that sidesteps all window/screen/DPI coordinate math.
ipcMain.on("desktop:menu-popup", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const menu = Menu.getApplicationMenu();
  if (win && menu) menu.popup({ window: win });
});

// ---- proxy setting ----------------------------------------------------------
// Changing the proxy needs the Next child restarted, so the renderer only
// writes the setting; main applies it and reloads the window. The restart is
// deferred to the next launch for the server (spawning it mid-flight would
// blank the app), but Chromium picks it up immediately.
ipcMain.handle("desktop:proxy-get", () => readProxyConfig());

ipcMain.handle("desktop:proxy-set", (_event, next) => {
  const previous = readProxyConfig();
  const mode = PROXY_MODES.includes(next?.mode) ? next.mode : "system";
  const config = { mode, url: normalizeProxyUrl(next?.url) };
  writeProxyConfig(config);
  bootLog(`[proxy] saved mode=${mode}`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.session
      .setProxy({
        proxyRules: proxyRulesFor(config),
        proxyBypassRules: "localhost,127.0.0.1,[::1]",
      })
      .catch((error) => bootLog(`[proxy] setProxy failed: ${error?.message || error}`));
  }

  // The Next child read the proxy env once at startup (instrumentation.ts), so
  // a change has to reach it somehow. Chromium picks the new rule up
  // immediately; the server needs a fresh child. Relaunch the window (which
  // restarts Next) instead of only telling the user to restart later — a stale
  // server is what produced "Failed to fetch" the moment the user flipped to
  // system proxy.
  const changed =
    previous.mode !== config.mode || previous.url !== config.url;
  if (changed && !proxyRestartInFlight) {
    proxyRestartInFlight = true;
    // A full relaunch, not a window reload: the Next child is spawned once
    // with the proxy env baked in, and instrumentation.ts reads it at startup.
    // Relaunching is the only way the server actually picks up the new mode.
    setTimeout(() => {
      bootLog(`[proxy] relaunching to apply mode=${config.mode}`);
      // args: dev launches as `electron .` — without passing argv[1..] back the
      // relaunched dev instance would start with no app path.
      app.relaunch({ args: process.argv.slice(1) });
      app.exit(0);
    }, 400);
  }

  return { ...config, restartRequired: changed };
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
      // Present in the reference bar the overlay row replaces; role fills in
      // Undo/Redo/Cut/Copy/Paste/Select All with OS-localised labels.
      role: "editMenu",
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

// GitHub returns release notes as HTML (<p>, <br>, <li>) but the update modal
// renders plain text, so tags must never reach the renderer.
function stripHtml(html) {
  const text = String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&") // last, so entities decode exactly once
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function releaseNotesText(info) {
  if (!info) return null;
  const notes = info.releaseNotes;
  if (!notes) return null;
  if (typeof notes === "string") return stripHtml(notes).slice(0, 2000);
  if (Array.isArray(notes)) {
    return stripHtml(
      notes
        .map((entry) => (entry && entry.note ? String(entry.note) : ""))
        .filter(Boolean)
        .join("\n\n"),
    ).slice(0, 2000);
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
// The renderer sends the colours it actually resolved for the current theme
// (they differ per theme — 16 palettes, not just light/dark), so the caption
// overlay and the window background match the strip exactly.
ipcMain.on("desktop:theme", (_event, theme, colors) => {
  const light =
    theme === "light" ||
    (theme !== "dark" && nativeTheme.shouldUseDarkColors === false);
  nativeTheme.themeSource = light ? "light" : "dark";
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Validate before use: this is a renderer-supplied string that reaches a
    // native call, and a malformed colour would throw inside Chromium.
    const bg = /^#[0-9a-fA-F]{6}$/.test(colors?.background) ? colors.background : null;
    const fg = /^#[0-9a-fA-F]{6}$/.test(colors?.foreground) ? colors.foreground : null;
    mainWindow.setBackgroundColor(bg || (light ? "#ffffff" : "#000000"));
    // The in-window strip paints with var(--background), so the caption
    // overlay has to follow it or the top of the window splits in two.
    mainWindow.setTitleBarOverlay({
      color: bg || (light ? "#ffffff" : "#050505"),
      symbolColor: fg || (light ? "#1a1a1a" : "#e3e3e3"),
      height: CAPTION_BUTTON_HEIGHT,
    });
    // Logged so the caption colours can be asserted without a native probe.
    bootLog(
      `[theme] mode=${light ? "light" : "dark"} bg=${bg || "-"} fg=${fg || "-"}`
    );
  }
});

// Dev-only: remote debugging port so the UI can be driven and inspected.
// commandLine switches must be set before the app is ready; the env var is
// only ever set by a developer's shell, never in a packaged build.
if (process.env.STREAMIFY_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.STREAMIFY_DEBUG_PORT);
}

// ---- boot ------------------------------------------------------------------
// Widevine CDM: this build ships the castlabs Electron fork (Electron for
// Content Security), which is the only Electron that can decrypt Widevine —
// stock Electron has no CDM and Shaka fails with 6001. The CDM is fetched
// from Google on first run and cached under userData; whenReady() resolves
// once it is registered, so awaiting it here keeps boot non-blocking while
// guaranteeing the CDM exists before any DRM track can be attempted.
async function ensureWidevineCdm() {
  try {
    const { components } = require("electron");
    if (!components || typeof components.whenReady !== "function") return false;
    await components.whenReady();
    const status = components.status();
    const widevine = status && status["oimompecagnajdejgnnjijobebaeigek"];
    bootLog(`[drm] widevine cdm ${widevine ? widevine.version : "unavailable"}`);
    return Boolean(widevine);
  } catch (err) {
    bootLog(`[drm] widevine cdm init failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function boot() {
  await app.whenReady();
  await ensureWidevineCdm();
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
  // Resolve before starting either server: the child inherits env at spawn
  // time and the in-process API reads it when startApiServer() runs.
  bootProxyUrl = await resolveProxyUrl();
  if (bootProxyUrl) {
    process.env.HTTPS_PROXY = bootProxyUrl;
    process.env.HTTP_PROXY = bootProxyUrl;
  } else {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
  }
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
  //
  // loadURL can reject with ERR_FAILED even when the app did load (a renderer
  // reload or an early redirect supersedes the pending load). Booting is not
  // allowed to die on that, so treat a rejection as non-fatal — the
  // did-finish-load handler below does the parts that must happen.
  try {
    await mainWindow.loadURL(APP_ORIGIN);
  } catch (error) {
    bootLog(`[boot] loadURL reported ${error?.message || error} — continuing if the page lands`);
  }
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
