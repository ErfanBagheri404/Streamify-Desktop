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
  setTheme: (theme) => ipcRenderer.send("desktop:theme", theme),
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
});
