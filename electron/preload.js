const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("streamifyDesktop", {
  platform: process.platform,
  onMediaKey: (callback) => {
    ipcRenderer.on("media-key", (_evt, key) => callback(key));
  },
});
