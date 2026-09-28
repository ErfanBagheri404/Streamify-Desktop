// Proves the yt-dlp fallback resolves a YouTube track through the in-process
// API, with invidious/piped forced to fail so the fallback is what answers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Runtime config with every HTTP instance replaced by an unroutable host, so
// only the yt-dlp provider can succeed.
const cfgPath = path.join(root, "api", "runtime-config.json");
const original = fs.readFileSync(cfgPath, "utf8");
const cfg = JSON.parse(original);
cfg.instances = { piped: ["https://127.0.0.1:9"], invidious: ["https://127.0.0.1:9"] };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log("forced instances ->", JSON.stringify(cfg.instances));

const child = spawn(
  process.execPath,
  [path.join(root, "dist", "api-server.mjs")],
  {
    cwd: root,
    env: { ...process.env, STREAMIFY_API_PORT: "7899", STREAMIFY_API_STANDALONE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }
);
let out = "";
child.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => process.stderr.write(d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:7899/config");
      if (r.ok) break;
    } catch {}
    await wait(300);
  }

  console.log("\n--- /video via yt-dlp fallback ---");
  const t0 = Date.now();
  const res = await fetch(
    "http://127.0.0.1:7899/video?id=aqz-KE-bpKQ&source=youtube",
    { headers: { Origin: "http://localhost:3000" } }
  );
  const json = await res.json();
  console.log(`status=${res.status} in ${Date.now() - t0}ms`);
  console.log("title:", json.title);
  console.log("author:", json.author);
  console.log("lengthSeconds:", json.lengthSeconds);
  console.log("has audioUrl:", typeof json.audioUrl === "string" && json.audioUrl.length > 0);
  console.log("audioUrl:", String(json.audioUrl).slice(0, 110));

  if (typeof json.audioUrl === "string" && json.audioUrl) {
    console.log("\n--- fetching the relayed audio ---");
    const a = await fetch(json.audioUrl, {
      headers: { Range: "bytes=0-2047", Origin: "http://localhost:3000" },
    });
    console.log("audio status:", a.status, "type:", a.headers.get("content-type"));
    const text = await a.text();
    console.log("body:", text.slice(0, 300));
    const buf = Buffer.from(text, "utf8");
    console.log("first bytes:", buf.slice(0, 8).toString());
  }
} finally {
  child.kill();
  fs.writeFileSync(cfgPath, original);
  console.log("\nrestored runtime-config.json");
}
