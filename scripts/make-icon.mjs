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
mkdirSync(path.join(root, "build"), { recursive: true });

// The SVG is a white glyph with no background, and a transparent capture comes
// out as solid black, so the page wrapper supplies the dark app background.
const svgUrl = "file:///" + path.join(root, "app", "public", "StreamifyLogo.svg").split("\\").join("/");
const html =
  '<!doctype html><meta charset="utf-8"><style>' +
  "html,body{margin:0;padding:0;width:512px;height:512px;background:#111318;overflow:hidden}" +
  "img{width:512px;height:512px;display:block}" +
  `</style><img src="${svgUrl}">`;

const svgPath = path.join(root, "app", "public", "StreamifyLogo.svg");

const helper = `
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const SVG_PATH = ${JSON.stringify(svgPath)};
app.on("window-all-closed", () => process.exit(0));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false,
  });
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const d = (svg.match(/<path[^>]*d="([^"]+)"/) || [])[1] || "";
  const page = "<!doctype html><meta charset=utf-8><style>"
    + "html,body{margin:0;padding:0;width:512px;height:512px;background:#111318;overflow:hidden}"
    + "canvas{width:512px;height:512px;display:block}"
    + "</style><canvas id=c width=512 height=512></canvas><script>"
    + "var c=document.getElementById('c').getContext('2d');"
    + "c.scale(512/35,512/35);c.fillStyle='#fff';c.fill(new Path2D(" + JSON.stringify(d) + "));"
    + "</scr" + "ipt>";
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(${JSON.stringify(tmpFile)}, image.toPNG());
  app.exit(0);
});
`;
writeFileSync(helperPath, helper);

// `require("electron")` resolves to the platform's binary (electron.exe,
// Electron.app/Contents/MacOS/Electron, electron), so this script runs on
// Windows, macOS and Linux CI hosts unchanged.
const electronBinary = createRequire(import.meta.url)("electron");
const proc = spawn(electronBinary, [helperPath], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
const code = await new Promise((r) => proc.on("exit", r));
if (code !== 0 || !existsSync(tmpFile) || statSync(tmpFile).size < 1000) {
  console.error(`icon render failed (exit ${code})`);
  process.exit(1);
}
copyFileSync(tmpFile, outFile);
unlinkSync(tmpFile);
unlinkSync(helperPath);
console.log(`wrote ${outFile} (${statSync(outFile).size} bytes)`);
