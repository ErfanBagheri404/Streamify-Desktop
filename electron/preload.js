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
  setTheme: (theme) => ipcRenderer.send("desktop:theme", theme),
  onCommand: (callback) => {
    ipcRenderer.on("desktop:command", (_event, command) => callback(command));
  },
});
