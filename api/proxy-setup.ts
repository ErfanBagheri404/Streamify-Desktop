// Proxy support for the in-process API server.
//
// This bundle runs inside the Electron main process, so it shares the main
// process's *builtin* fetch — a separate copy of undici that ignores both
// `HTTPS_PROXY` env and any dispatcher installed elsewhere. app/instrumentation.ts
// documents the same dance for the Next child; this is the mirror of it.
//
// main.js resolves the proxy once at boot (resolveProxyUrl) and exports it via
// process.env.HTTPS_PROXY / HTTP_PROXY before importing this module. With no
// proxy env vars the whole thing is a no-op and everything stays direct.
export async function installProxyFromEnv(): Promise<void> {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return;

  try {
    const undici = await import("undici");
    // Never proxy loopback: the renderer talks to this server on 127.0.0.1.
    process.env.NO_PROXY = process.env.NO_PROXY || "localhost,127.0.0.1,::1";
    // Keep auth hosts direct — measured: the local proxy cannot reach
    // Supabase while it answers directly in ~0.4s (see instrumentation.ts).
    const directHosts =
      "supabase.co,supabase.in,supabase.com,vercel.app,*.supabase.co";
    if (!/(^|,).?\s*supabase\.co\b/.test(process.env.NO_PROXY)) {
      process.env.NO_PROXY = `${process.env.NO_PROXY},${directHosts}`;
    }
    process.env.no_proxy = process.env.NO_PROXY;
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    // The builtin fetch must be replaced with undici's own — see
    // instrumentation.ts note 1 for why the env var alone steers nothing.
    globalThis.fetch = undici.fetch as unknown as typeof fetch;
    console.log(`[api-proxy] server fetch via proxy ${proxy}`);
  } catch (error) {
    // A broken proxy config must not take the API down — log and stay direct.
    console.error("[api-proxy] dispatcher setup failed:", error);
  }
}
