// Windows taskbar thumbnail toolbar (Thumbar) buttons: add-to-liked,
// previous, play/pause, next. Mirrors playback from the renderer (via main).
//
// Same progressive-enhancement contract as SMTC: a missing OS or missing app
// handle must never break the app — if setThumbarButtons throws, log and move on.
const { nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let mainWindow = null;
let bootLog = () => {};
let sendCommandRef = () => {};
let iconDir = null;

function setWindow(win) { mainWindow = win; }
function setBootLog(fn) { if (typeof fn === "function") bootLog = fn; }
function setCommandSender(fn) { if (typeof fn === "function") sendCommandRef = fn; }
function setIconDir(dir) { iconDir = dir; }

function loadIcon(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return nativeImage.createFromPath(file);
  } catch (err) {
    try { bootLog("thumbar icon load failed " + String(err?.message || err)); } catch {}
    return null;
  }
}

function isSupported() {
  return process.platform === "win32" && !!mainWindow && !mainWindow.isDestroyed();
}

function icon(name) {
  if (!iconDir) return null;
  return loadIcon(path.join(iconDir, name + ".png"));
}

function update(state) {
  if (!isSupported()) return;
  const s = state || {};
  const song = !!s.song;
  const play = s.play !== false;
  const buttons = [];

  const likedIcon = song
    ? s.liked ? icon("like-filled") : icon("like-outline")
    : icon("like-outline");
  buttons.push({
    tooltip: song
      ? s.liked ? "Remove from Liked Songs" : "Add to Liked Songs"
      : "Liked Songs",
    icon: likedIcon || nativeImage.createEmpty(),
    flags: song && likedIcon ? [] : ["disabled"],
    click: () => {
      try { sendCommandRef("like", undefined); } catch (err) { bootLog?.(String(err)); }
    },
  });

  const prevIcon = icon("previous");
  buttons.push({
    tooltip: "Previous",
    icon: prevIcon || nativeImage.createEmpty(),
    flags: song && s.hasPrevious && prevIcon ? [] : ["disabled"],
    click: () => {
      try { sendCommandRef("previous", undefined); } catch (err) { bootLog?.(String(err)); }
    },
  });

  let ppIcon = play ? icon("pause") : icon("play");
  if (!ppIcon || ppIcon.isEmpty()) ppIcon = icon("play");
  buttons.push({
    tooltip: play ? "Pause" : "Play",
    icon: ppIcon || nativeImage.createEmpty(),
    flags: song && ppIcon ? [] : ["disabled"],
    click: () => {
      try { sendCommandRef("play-pause", undefined); } catch (err) { bootLog?.(String(err)); }
    },
  });

  const nextIcon = icon("next");
  buttons.push({
    tooltip: "Next",
    icon: nextIcon || nativeImage.createEmpty(),
    flags: song && s.hasNext && nextIcon ? [] : ["disabled"],
    click: () => {
      try { sendCommandRef("next", undefined); } catch (err) { bootLog?.(String(err)); }
    },
  });

  try {
    // setThumbarButtons returns false when Windows refuses the button set, so
    // surface that instead of leaving a silently missing toolbar.
    const ok = mainWindow.setThumbarButtons(buttons);
    if (!ok) bootLog("thumbar setThumbarButtons returned false");
  } catch (err) {
    try { bootLog("thumbar setThumbarButtons failed: " + String(err?.message || err)); } catch {}
  }
}

function clear() { update({ song: false, play: false, hasNext: false, hasPrevious: false, liked: false }); }

module.exports = {
  setWindow,
  setBootLog,
  setCommandSender,
  setIconDir,
  isSupported,
  update,
  clear,
};
