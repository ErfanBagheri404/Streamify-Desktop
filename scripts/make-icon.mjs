// Renders app/public/StreamifyLogo.svg to build/icon.png (512x512, the minimum
// electron-builder accepts for auto-generating the Windows .ico). Uses Electron
// itself as the rasterizer, so the build needs no image toolchain.
//   node scripts/make-icon.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  copyFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outFile = path.join(root, "build", "icon.png");
const tmpFile = path.join(root, "build", "icon-raw.png");
const helperPath = path.join(root, "build", "icon-helper.cjs");
const trayFile = path.join(root, "build", "icon-tray.png");
mkdirSync(path.join(root, "build"), { recursive: true });

// If both committed PNGs already exist, skip rendering. Spawning Electron on
// headless Linux CI fails without xvfb ($DISPLAY missing). Pass --force to
// re-render (e.g. after changing the logo or the background colour).
const haveAll =
  existsSync(outFile) &&
  statSync(outFile).size > 1000 &&
  existsSync(trayFile) &&
  statSync(trayFile).size > 1000;
if (haveAll && !process.argv.includes("--force")) {
  console.log(`icons already exist in ${path.dirname(outFile)} — skipping render`);
  process.exit(0);
}

// The SVG is a white glyph with no background, and a transparent capture comes
// out as solid black, so the page wrapper supplies the dark app background.
const svgUrl = "file:///" + path.join(root, "app", "public", "StreamifyLogo.svg").split("\\").join("/");
const html =
  '<!doctype html><meta charset="utf-8"><style>' +
  "html,body{margin:0;padding:0;width:512px;height:512px;background:#111318;overflow:hidden}" +
  "img{width:512px;height:512px;display:block}" +
  `</style><img src="${svgUrl}">`;

const svgPath = path.join(root, "app", "public", "StreamifyLogo.svg");

// [output file, background]. null = transparent (tray), colour = installer tile.
const TRAY_VARIANTS = [
  [outFile, "#111318"],
  [trayFile, null],
];

// Two variants come out of one render pass:
//   icon.png        — opaque dark tile for the installers (NSIS/dmg/deb/shortcut)
//   icon-tray.png   — transparent background, glyph only, for the tray icon
// A tray icon is drawn over the desktop, so any baked-in background shows up
// as a coloured square around the glyph.
const helper = `
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const SVG_PATH = ${JSON.stringify(svgPath)};
app.on("window-all-closed", () => process.exit(0));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false,
    // Without this Chromium composites the transparent canvas to white, which
    // is what made the tray icon a blank white square.
    backgroundColor: "transparent",
  });
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const d = (svg.match(/<path[^>]*d="([^"]+)"/) || [])[1] || "";
  // Draw the glyph once per variant: the installer tile fills the canvas with
  // the app surface colour first, the tray variant draws on a clear canvas.
  // The PNG is read straight off the canvas (toDataURL), not capturePage —
  // capturePage composites the window to opaque white, which made the tray
  // icon a blank square.
  const draw = (bg) =>
    "<!doctype html><meta charset=utf-8><style>"
    + "html,body{margin:0;padding:0;width:512px;height:512px;overflow:hidden}"
    + "canvas{width:512px;height:512px;display:block}"
    + "</style><canvas id=c width=512 height=512></canvas><script>"
    + "var c=document.getElementById('c').getContext('2d');"
    + (bg ? "c.fillStyle=" + JSON.stringify(bg) + ";c.fillRect(0,0,512,512);" : "")
    + "c.scale(512/35,512/35);c.fillStyle='#fff';c.fill(new Path2D(" + JSON.stringify(d) + "));"
    + "</scr" + "ipt>";

  for (const [file, bg] of ${JSON.stringify(TRAY_VARIANTS)}) {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(draw(bg)));
    await new Promise((r) => setTimeout(r, 400));
    const dataUrl = await win.webContents.executeJavaScript(
      "document.getElementById('c').toDataURL('image/png')"
    );
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(",")[1] || "", "base64"));
  }
  app.exit(0);
});
`;
writeFileSync(helperPath, helper);

// `require("electron")` resolves to the platform's binary (electron.exe,
// Electron.app/Contents/MacOS/Electron, electron), so this script runs on
// Windows, macOS and Linux CI hosts unchanged. On Linux CI the runner cannot
// chown chrome-sandbox to root (mode 4755), so the sandbox must be off — the
// window is offscreen and never renders untrusted content.
const electronBinary = createRequire(import.meta.url)("electron");
const args = [helperPath];
if (process.platform === "linux") args.push("--no-sandbox");
const proc = spawn(electronBinary, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
const code = await new Promise((r) => proc.on("exit", r));
if (code !== 0 || !existsSync(outFile) || statSync(outFile).size < 1000) {
  console.error(`icon render failed (exit ${code})`);
  process.exit(1);
}
unlinkSync(helperPath);
console.log(`wrote ${outFile} (${statSync(outFile).size} bytes)`);
console.log(`wrote ${trayFile} (${statSync(trayFile).size} bytes)`);
