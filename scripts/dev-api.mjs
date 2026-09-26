// Dev API launcher: bundle api/server.ts with esbuild on the fly, then run it.
// Avoids needing tsx and avoids cold-start rebuilds on the packaged app.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";

const esbuild = spawn(
  "npx",
  ["esbuild", "api-server.mjs", "--bundle", "--platform=node", "--format=esm", "--outfile=dist/api-server.mjs", "--watch"],
  { cwd: root, stdio: "inherit", shell: true }
);

const run = () =>
  spawn("node", ["dist/api-server.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, STREAMIFY_API_PORT: process.env.STREAMIFY_API_PORT || "7861" },
  });

let api = null;
esbuild.stdout?.on?.("data", () => {});

// naive: wait briefly then start node, kill/restart on file change is left to esbuild --watch manual re-run
setTimeout(() => {
  api = run();
}, 1500);

process.on("SIGINT", () => {
  api?.kill();
  esbuild.kill();
  process.exit(0);
});
