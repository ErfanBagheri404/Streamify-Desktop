// Launch the Electron app detached with remote-debugging enabled, so scripts/cdp.mjs
// can drive it and screenshot the real packaged UI.
// Usage: STREAMIFY_DEBUG_PORT=9444 node scripts/launch-app.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, ".logs");
fs.mkdirSync(logDir, { recursive: true });

const PORT = Number(process.env.STREAMIFY_DEBUG_PORT || 9444);
const child = spawn(path.join(root, "node_modules", "electron", "dist", "electron.exe"), ["."], {
  cwd: root,
  detached: true,
  stdio: ["ignore", fs.openSync(path.join(logDir, "probe-app.log"), "a"), fs.openSync(path.join(logDir, "probe-app.err.log"), "a")],
  env: { ...process.env, STREAMIFY_DEBUG_PORT: String(PORT) },
});
child.unref();
console.log("launched pid=" + child.pid);

const deadline = Date.now() + 90000;
const attempt = () => {
  const s = net.connect({ host: "127.0.0.1", port: PORT }, () => {
    s.destroy();
    console.log("debug-port ready " + PORT);
    process.exit(0);
  });
  s.on("error", () => {
    s.destroy();
    if (Date.now() > deadline) {
      console.log("timeout on " + PORT);
      process.exit(1);
    }
    setTimeout(attempt, 500);
  });
};
attempt();
