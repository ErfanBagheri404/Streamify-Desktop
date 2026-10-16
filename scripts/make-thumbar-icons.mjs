// Renders white glyph icons (for Windows taskbar thumbnail buttons) into
// build/thumbar/*.png at 32x32, transparent background. Uses Electron itself as
// the rasterizer (same approach as make-icon.mjs), so the build needs no image
// toolchain.
//   node scripts/make-thumbar-icons.mjs   (--force to re-render)
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "build", "thumbar");
mkdirSync(outDir, { recursive: true });

const glyphs = {
  play: { fill: "M8.75 6.6c0-1.01 1.11-1.63 1.98-1.1l7.61 4.65a1.3 1.3 0 0 1 0 2.2l-7.61 4.65c-.87.53-1.98-.09-1.98-1.1V6.6Z" },
  pause: { fill: "M7.75 5.5A1.25 1.25 0 0 1 9 6.75v10.5a1.25 1.25 0 1 1-2.5 0V6.75A1.25 1.25 0 0 1 7.75 5.5Zm8.5 0a1.25 1.25 0 0 1 1.25 1.25v10.5a1.25 1.25 0 1 1-2.5 0V6.75a1.25 1.25 0 0 1 1.25-1.25Z" },
  previous: { fill: "M19 20 9 12l10-8v16ZM5 19V5" },
  next: { fill: "M5 4l10 8-10 8V4ZM19 5v14" },
  "like-filled": { fill: "M12 21.35 10.55 20C5.4 15.24 2 12.09 2 8.22 2 5.07 4.42 2.65 7.57 2.65c1.78 0 3.49.82 4.43 2.12.94-1.3 2.65-2.12 4.43-2.12C19.58 2.65 22 5.07 22 8.22c0 3.87-3.4 7.02-8.55 11.78L12 21.35Z" },
  "like-outline": { stroke: "M12 20.25s-7.5-4.35-7.5-10.125A4.125 4.125 0 0 1 8.625 6a4.68 4.68 0 0 1 3.375 1.575A4.68 4.68 0 0 1 15.375 6 4.125 4.125 0 0 1 19.5 10.125C19.5 15.9 12 20.25 12 20.25Z" },
};

const SIZE = 32;
const helperPath = path.join(outDir, "_render.cjs");
const names = Object.keys(glyphs);

const alreadyRendered = names.every((name) => {
  const file = path.join(outDir, name + ".png");
  return existsSync(file) && statSync(file).size > 500;
});
if (alreadyRendered && !process.argv.includes("--force")) {
  console.log("thumbar icons already present — skipping render");
  process.exit(0);
}

// The renderer helper is built as an array of source lines. Closing tags are
// split so nothing in this file can be mistaken for markup by a linter or an
// HTML-aware tool reading the file.
const helperLines = [
  'const { app, BrowserWindow } = require("electron");',
  'const path = require("path");',
  'const fs = require("fs");',
  "const glyphs = " + JSON.stringify(glyphs) + ";",
  "const SIZE = " + SIZE + ";",
  "const outDir = " + JSON.stringify(outDir) + ";",
  "const names = " + JSON.stringify(names) + ";",
  'app.on("window-all-closed", () => process.exit(0));',
  "app.whenReady().then(async () => {",
  '  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, backgroundColor: "transparent" });',
  "  for (const name of names) {",
  "    const gd = glyphs[name];",
  "    let op;",
  "    if (gd.stroke) {",
  '      op = "c.strokeStyle=\'#ffffff\';c.lineWidth=2.4;c.lineCap=\'round\';c.lineJoin=\'round\';c.stroke(new Path2D(" + JSON.stringify(gd.stroke) + "));";',
  "    } else {",
  '      op = "c.fillStyle=\'#ffffff\';c.fill(new Path2D(" + JSON.stringify(gd.fill) + "));";',
  "    }",
  '    const open = "<" + "scr" + "ipt>";',
  '    const close = "</" + "scr" + "ipt>";',
  '    const htmlDoc = "<!doctype html><meta charset=utf-8><style>html,body{margin:0;padding:0;width:"',
  '      + SIZE + "px;height:" + SIZE + "px;overflow:hidden}canvas{width:" + SIZE + "px;height:" + SIZE + "px;display:block}</style>"',
  '      + "<canvas id=c width=" + SIZE + " height=" + SIZE + "></canvas>" + open',
  "      + \"var c=document.getElementById('c').getContext('2d');c.scale(\" + " + (SIZE / 24) + " + \",\" + " + (SIZE / 24) + " + \");\" + op + close;",
  '    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(htmlDoc));',
  "    await new Promise((r) => setTimeout(r, 300));",
  "    const dataUrl = await win.webContents.executeJavaScript(\"document.getElementById('c').toDataURL('image/png')\");",
  '    fs.writeFileSync(path.join(outDir, name + ".png"), Buffer.from(String(dataUrl).split(",")[1] || "", "base64"));',
  "  }",
  "  app.exit(0);",
  "});",
  "",
];
writeFileSync(helperPath, helperLines.join("\n"));

const electronBinary = createRequire(import.meta.url)("electron");
const proc = spawnSync(electronBinary, [helperPath], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
try {
  unlinkSync(helperPath);
} catch {
  /* helper already gone */
}
if (proc.status !== 0) {
  console.error("thumbar icon render failed (exit " + proc.status + ")");
  process.exit(1);
}
for (const name of names) {
  const file = path.join(outDir, name + ".png");
  console.log("wrote " + file + " (" + statSync(file).size + " bytes)");
}
