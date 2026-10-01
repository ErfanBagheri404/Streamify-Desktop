// Next runs as a child process under ELECTRON_RUN_AS_NODE, so its global
// `fetch` (undici) does NOT inherit Chromium's system-proxy resolution —
// `session.resolveProxy` only affects the renderer. On top of that the local
// DNS resolver can be poisoned or flaky for the Supabase host, so a direct
// fetch dies with ENOTFOUND / ConnectTimeoutError and the browser-mediated
// auth handoff fails with "could not store the session: Failed to fetch".
//
// Fix: route the server's fetch through the same proxy the OS uses. main.js
// resolves it via `session.resolveProxy` and passes HTTPS_PROXY/HTTP_PROXY in
// the child's env; this file installs a proxy dispatcher that honours them.
//
// Two non-obvious details, both verified against the real proxy:
//   1. npm undici's `setGlobalDispatcher` does NOT steer Node's *builtin*
//      fetch — they are separate copies of undici. The builtin must be
//      replaced with undici's own fetch, which does honour the dispatcher.
//   2. `EnvHttpProxyAgent(url)` ignores the URL argument (it is a pac token);
//      the proxy is read from env at construction time. So env must be set
//      before the agent is built.
//
// With no proxy env vars this whole thing is a no-op.
export async function register() {
  // Next calls register() for every runtime; only the Node server can use
  // undici dispatchers (edge has its own fetch).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return;

  try {
    const undici = await import("undici");
    // Never proxy loopback: the renderer and the in-process API both talk to
    // the local Next server, and routing that through an external proxy would
    // send the app's own traffic out of the machine.
    process.env.NO_PROXY = process.env.NO_PROXY || "localhost,127.0.0.1,::1";
    process.env.no_proxy = process.env.NO_PROXY;
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    // Point the builtin global at undici's proxy-aware fetch (see note 1).
    // The cast is required: undici's own `Request` type is not structurally
    // identical to the DOM lib's, so the assignment is not type-safe on paper
    // (it is at runtime — both are the same undici implementation).
    globalThis.fetch = undici.fetch as unknown as typeof fetch;
    console.log(`[instrumentation] server fetch via proxy ${proxy}`);
  } catch (error) {
    // A broken proxy config must not take the server down — log and keep the
    // direct dispatcher so the app still boots.
    console.error("[instrumentation] proxy dispatcher setup failed:", error);
  }
}
