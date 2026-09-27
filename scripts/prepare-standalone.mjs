// Next's `output: "standalone"` build does NOT copy three things the packaged
// app needs, so Electron can run it without node_modules:
//   .next/static  -> public assets referenced by the server-rendered HTML
//   public/       -> same reason
//   .env.local    -> runtime secrets for the server-side API routes
//     (NEXT_PUBLIC_* is already inlined into the JS bundles at build time,
//      so only the non-public values actually need this file at runtime)
//
// Run after `next build`:
//   node scripts/prepare-standalone.mjs
import { cpSync, existsSync, copyFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const buildDir = path.join(root, "app", ".next");
const standalone = path.join(buildDir, "standalone");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error(`missing ${standalone}/server.js — run "npm run build:app" first`);
  process.exit(1);
}

const steps = [
  [path.join(buildDir, "static"), path.join(standalone, ".next", "static")],
  [path.join(root, "app", "public"), path.join(standalone, "public")],
];
for (const [from, to] of steps) {
  if (!existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

const envFile = path.join(root, "app", ".env.local");
if (existsSync(envFile)) {
  // In dev the Next dev server may hold this file open (EBUSY on Windows),
  // and the dev app never reads it here — main.js loads it from app/.env.local.
  // In a packaged build the file ships via extraResources, not from this dir.
  try {
    copyFileSync(envFile, path.join(standalone, ".env.local"));
    console.log("copied app/.env.local -> standalone/.env.local");
  } catch (e) {
    if (e && e.code === "EBUSY") {
      console.log("skipped app/.env.local (open in another process; the dev server serves its own)");
    } else {
      throw e;
    }
  }
} else {
  console.log("no app/.env.local (server-side routes will run without secrets)");
}

const dirSize = (p) => {
  if (!statSync(p).isDirectory()) return statSync(p).size;
  return readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
};
console.log(`standalone ready: ${(dirSize(standalone) / 1024 / 1024).toFixed(1)} MB`);
