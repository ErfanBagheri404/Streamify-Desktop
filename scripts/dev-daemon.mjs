// Detached launcher: starts API + Next dev, writes PIDs, survives parent shell exit.
// Usage: node scripts/dev-daemon.mjs start|stop|status
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, ".logs");
const pidFile = path.join(logDir, "dev.pids.json");
const API_PORT = Number(process.env.STREAMIFY_API_PORT || 7861);
const APP_PORT = Number(process.env.STREAMIFY_APP_PORT || 3000);

fs.mkdirSync(logDir, { recursive: true });

const readPids = () => {
  try {
    return JSON.parse(fs.readFileSync(pidFile, "utf8"));
  } catch {
    return {};
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitPort = (port, timeoutMs = 120000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`timeout on ${port}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });

const start = async () => {
  const pids = readPids();
  const tasks = [];

  if (!pids.api || !alive(pids.api)) {
    const api = spawn("node", ["dist/api-server.mjs"], {
      cwd: root,
      detached: true,
      stdio: ["ignore", fs.openSync(path.join(logDir, "api.log"), "a"), fs.openSync(path.join(logDir, "api.err.log"), "a")],
      env: {
        ...process.env,
        STREAMIFY_API_STANDALONE: "1",
        STREAMIFY_API_PORT: String(API_PORT),
        ALLOWED_ORIGINS: `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`,
      },
    });
    api.unref();
    pids.api = api.pid;
    tasks.push(["api", api.pid]);
  }

  if (!pids.next || !alive(pids.next)) {
    // Spawn next directly: `npm run dev` under shell:true spawns a cmd.exe that
    // dies with the parent, taking the listener with it.
    const nextBin = path.join(root, "app", "node_modules", "next", "dist", "bin", "next");
    const next = spawn(process.execPath, [nextBin, "dev", "--webpack"], {
      cwd: path.join(root, "app"),
      detached: true,
      stdio: ["ignore", fs.openSync(path.join(logDir, "next.log"), "a"), fs.openSync(path.join(logDir, "next.err.log"), "a")],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: String(APP_PORT) },
    });
    next.unref();
    pids.next = next.pid;
    tasks.push(["next", next.pid]);
  }

  fs.writeFileSync(pidFile, JSON.stringify(pids, null, 2));
  console.log("spawned", JSON.stringify(tasks));

  await Promise.all([waitPort(API_PORT), waitPort(APP_PORT)]);
  console.log(`ready api=${API_PORT} app=${APP_PORT}`);
};

const stop = () => {
  const pids = readPids();
  for (const [name, pid] of Object.entries(pids)) {
    if (!alive(pid)) continue;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      } else {
        process.kill(-pid, "SIGTERM");
      }
      console.log("stopped", name, pid);
    } catch (e) {
      console.log("stop failed", name, e.message);
    }
  }
  fs.writeFileSync(pidFile, "{}");
};

const status = () => {
  const pids = readPids();
  for (const [name, pid] of Object.entries(pids)) {
    console.log(name, pid, alive(pid) ? "alive" : "dead");
  }
};

const cmd = process.argv[2] || "status";
if (cmd === "start") await start();
else if (cmd === "stop") stop();
else status();
