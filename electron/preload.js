const { contextBridge, ipcRenderer } = require("electron");

// Playback commands from the menu and the OS media keys. The renderer's
// AudioContext owns the real playback state, so these are forwarded, not
// reimplemented in the main process.
//
// Nothing else is patched here on purpose: the preload runs in an isolated
// world, so stubbing page globals (navigator.serviceWorker and friends) here
// would not be visible to the app. AppBootstrap does that instead, in the
// main world, where it actually takes effect.
contextBridge.exposeInMainWorld("streamifyDesktop", {
  platform: process.platform,
  isDesktop: true,
  version: ipcRenderer.sendSync("desktop:app-info").version,
  // colors: { background, foreground } resolved by the renderer, so the
  // caption overlay matches the app palette (16 themes, not just light/dark).
  setTheme: (theme, colors) => ipcRenderer.send("desktop:theme", theme, colors),
  onCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:command", listener);
    return () => ipcRenderer.removeListener("desktop:command", listener);
  },
  // Push current track + playback state to the main process (Now Playing
  // notification + Linux MPRIS). High-frequency position goes over its own
  // fire-and-forget channel.
  reportNowPlaying: (payload) => ipcRenderer.send("desktop:now-playing", payload),
  reportPosition: (seconds) => ipcRenderer.send("desktop:position", seconds),
  // Self-update flow: main owns electron-updater, renderer owns the modal.
  update: {
    check: () => ipcRenderer.send("desktop:update-check"),
    download: () => ipcRenderer.send("desktop:update-download"),
    install: () => ipcRenderer.send("desktop:update-install"),
    onAvailable: (callback) =>
      ipcRenderer.on("desktop:update-available", (_event, info) => callback(info)),
    onProgress: (callback) =>
      ipcRenderer.on("desktop:update-progress", (_event, info) => callback(info)),
    onDownloaded: (callback) =>
      ipcRenderer.on("desktop:update-downloaded", (_event, info) => callback(info)),
    onNotAvailable: (callback) =>
      ipcRenderer.on("desktop:update-not-available", () => callback()),
    onError: (callback) =>
      ipcRenderer.on("desktop:update-error", (_event, info) => callback(info)),
  },
  // Browser-mediated sign-in. Main owns the PKCE verifier + the deep link, so
  // no auth secret is ever exposed to the renderer. The renderer only receives
  // the already-verified token hash and hands it to Supabase.
  // In-window overlay row: dots menu + back/forward chevrons. The native
  // title bar and the old menu bar row are both hidden, so this is now the
  // only way to reach the application menu without a keyboard.
  titleBar: {
    openMenu: () => ipcRenderer.send("desktop:menu-popup"),
  },
  auth: {
    start: () => ipcRenderer.sendSync("desktop:auth-start"),
    // Claim a redeem result the push missed (listener not attached yet).
    take: () => ipcRenderer.sendSync("desktop:auth-take"),
    onResult: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("desktop:auth-result", listener);
      return () => ipcRenderer.removeListener("desktop:auth-result", listener);
    },
    onError: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("desktop:auth-error", listener);
      return () => ipcRenderer.removeListener("desktop:auth-error", listener);
    },
  },
  // Proxy: main owns the setting (it decides how the Next child reaches the
  // network); the renderer just mirrors it for the UI.
  proxy: {
    get: () => ipcRenderer.invoke("desktop:proxy-get"),
    // Returns the saved config plus restartRequired — the server reads its
    // proxy env once at startup, so a change only fully applies on next launch.
    set: (config) => ipcRenderer.invoke("desktop:proxy-set", config),
  },
});
