// Runnable check for the desktop proxy path. Runs the standalone Next server
// exactly as electron/main.js does (ELECTRON_RUN_AS_NODE + standalone/server.js)
// and hits an API route that reaches Supabase.
//
//   run 1  HTTPS_PROXY set  -> instrumentation installs the proxy dispatcher,
//                             the Supabase call returns a real HTTP status
//   run 2  no proxy env     -> instrumentation no-ops, server still boots
//
// A passing run prints an HTTP status for both. ECONNREFUSED means the server
// never bound (check HOSTNAME); a DNS/UND_ERR_* failure means the dispatcher
// was not installed.
const { spawn } = require("node:child_process");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const standalone = path.join(repo, "app", ".next", "standalone", "server.js");
const electron = path.join(repo, "node_modules", "electron", "dist", "electron.exe");
const PROXY = process.env.STREAMIFY_TEST_PROXY || "http://127.0.0.1:10808";

let failed = false;

const run = (port, env) =>
  new Promise((resolve) => {
    const child = spawn(electron, [standalone], {
      // HOSTNAME must be set explicitly: on Windows the inherited HOSTNAME is
      // the machine name (e.g. "Erfan"), which Next uses as the bind address.
      env: {
        ...process.env,
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        HOSTNAME: "0.0.0.0",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    // Wait for "Ready in" — the instrumentation line prints before the bind.
    const deadline = Date.now() + 60000;
    const tick = setInterval(async () => {
      if (out.includes("Ready in") || Date.now() > deadline) {
        clearInterval(tick);
        if (out.includes("Ready in")) {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/account-status`).then(
            (r) => `HTTP ${r.status}`,
            (e) => `FETCH FAILED: ${e.cause?.code || e.message}`
          );
          console.log(`   /api/auth/account-status -> ${res}`);
          if (!/^HTTP /.test(res)) failed = true;
        } else {
          console.log("   server never became ready");
          failed = true;
        }
        child.kill();
        resolve(out);
      }
    }, 500);
  });

(async () => {
  console.log(`--- run 1: proxy ${PROXY} (dispatcher must install) ---`);
  const a = await run(3199, { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY });
  const installed = a.includes("[instrumentation] server fetch via proxy");
  console.log(`   ${installed ? "dispatcher installed" : "DISPATCHER MISSING"}`);
  if (!installed) failed = true;

  console.log("--- run 2: no proxy env (must no-op) ---");
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];
  const b = await run(3198, {});
  const leaked = b.includes("[instrumentation] server fetch via proxy");
  console.log(`   ${leaked ? "UNEXPECTED proxy install" : "no-op as expected"}`);
  if (leaked) failed = true;

  console.log(failed ? "\nFAIL" : "\nPASS");
  process.exit(failed ? 1 : 0);
})();
