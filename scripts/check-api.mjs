// Smoke test the bundled in-process API: health + an origin-gated route.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.STREAMIFY_API_PORT || 7861);
const proc = spawn("node", ["dist/api-server.mjs"], {
  env: {
    ...process.env,
    STREAMIFY_API_PORT: String(port),
    STREAMIFY_API_STANDALONE: "1",
    ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d) => process.stdout.write(`[api] ${d}`));
proc.stderr.on("data", (d) => process.stderr.write(`[api] ${d}`));

await delay(1200);
let failed = false;
const ORIGIN = { Origin: "http://localhost:3000" };

async function check(label, path, expectOk) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: ORIGIN });
    const body = await res.text();
    const ok = expectOk === null ? res.status !== 403 : expectOk ? res.ok : true;
    console.log(`${ok ? "PASS" : "FAIL"} ${label} ${res.status} ${body.slice(0, 140)}`);
    if (!ok) failed = true;
  } catch (e) {
    console.log(`FAIL ${label} ${e.message}`);
    failed = true;
  }
}

await check("health", "/health", true);
// lyrics rejects malformed params with 400; anything but 403 means origin gate passed
await check("lyrics origin-gate", "/lyrics?artist=daft+punk&track=get+lucky", null);
await check("search", "/search?q=daft+punk&source=youtube", true);

proc.kill();
process.exit(failed ? 1 : 0);
