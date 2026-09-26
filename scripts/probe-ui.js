// Dev-only UI probe: load a route, dump text + console errors, save a screenshot.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

// Electron argv: [electron(.exe), script.js, ...userArgs] with flags interleaved,
// so pick the URL by shape rather than a fixed index.
const userArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const urlArg = userArgs.find((a) => /^https?:|^about:/.test(a));
const fileArg = userArgs.find((a) => /\.png$/i.test(a));
const numArg = userArgs.find((a) => /^\d+$/.test(a));
const url = urlArg || "http://127.0.0.1:3000/";
const out = fileArg || path.join(process.cwd(), "shot.png");
const waitMs = Number(numArg || 6000);
const log = (...a) => {
  process.stdout.write("PROBE " + a.join(" ") + "\n");
};

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

log("stage=script-loaded url=" + url);
process.on("uncaughtException", (e) => log("UNCAUGHT " + e.message));
process.on("unhandledRejection", (e) => log("REJECT " + (e && e.message)));

app.whenReady().then(async () => {
  log("stage=app-ready");
  const w = new BrowserWindow({ width: 1400, height: 900, show: false });
  const errors = [];
  w.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(`[${level}] ${message}`);
  });
  w.webContents.on("did-fail-load", (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  log("stage=window-created");

  try {
    await w.loadURL(url);
    log("stage=loaded");
  } catch (e) {
    log("stage=load-failed " + e.message);
  }
  await new Promise((r) => setTimeout(r, waitMs));
  log("stage=waited");

  let text = "";
  try {
    text = await w.webContents.executeJavaScript(
      "document.body ? document.body.innerText.slice(0, 1200) : '(no body)'"
    );
  } catch (e) {
    errors.push("innerText failed: " + e.message);
  }
  log("stage=text-read");

  try {
    fs.writeFileSync(out, (await w.capturePage()).toPNG());
    log("stage=screenshot-saved " + out);
  } catch (e) {
    errors.push("capture failed: " + e.message);
  }

  log("TEXT_START>>>" + text + "<<<TEXT_END");
  log("ERRORS:" + (errors.slice(0, 12).join(" | ") || "none"));
  app.exit(0);
});

setTimeout(() => {
  log("stage=timeout-guard");
  app.exit(3);
}, waitMs + 45000);
