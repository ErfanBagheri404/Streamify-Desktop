// Downloads the pinned yt-dlp release binary for the build host into
// resources/bin/. Run at CI build time (and manually when the pin is bumped).
// Usage: node scripts/fetch-ytdlp.mjs [--force]
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const PINNED_VERSION = "2026.08.19";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "resources", "bin");

const asset =
  process.platform === "win32"
    ? "yt-dlp.exe"
    : process.platform === "darwin"
      ? "yt-dlp_macos"
      : "yt-dlp";

const isWin = process.platform === "win32";
const outFile = path.join(outDir, isWin ? "yt-dlp.exe" : "yt-dlp");

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "streamify-desktop-build",
            Accept: "application/octet-stream",
          },
        },
        (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            get(res.headers.location).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }
      )
      .on("error", reject);
  });
}

async function main() {
  const force = process.argv.includes("--force");
  if (fs.existsSync(outFile) && !force) {
    console.log(`yt-dlp already present (${outFile}), skipping`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${PINNED_VERSION}/${asset}`;
  console.log(`downloading ${url} ...`);
  const data = await get(url);
  fs.writeFileSync(outFile, data);
  if (!isWin) fs.chmodSync(outFile, 0o755);
  const sizeMB = (data.length / 1024 / 1024).toFixed(1);
  console.log(`wrote ${outFile} (${sizeMB} MB)`);
}

main().catch((err) => {
  console.error("fetch-ytdlp failed:", err?.message || err);
  process.exit(1);
});
