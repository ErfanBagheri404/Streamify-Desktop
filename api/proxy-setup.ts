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
    process.env.http_proxy ||
    // The app-level proxy setting is honoured by resolveProxyUrl() and only
    // feeds the two proxies above. When it is off, this server still needs a
    // way out: soundcloud.com is unreachable directly on this network, so
    // getSoundCloudClientId() burned its whole 12s budget three times and
    // every SoundCloud track 500'd with "Failed to resolve SoundCloud client
    // id". STREAMIFY_MEDIA_PROXY is the OS proxy, handed over separately.
    process.env.STREAMIFY_MEDIA_PROXY;
  if (!proxy) return;

  // EnvHttpProxyAgent reads the proxy from env at construction time, so make
  // sure the value it will see is the one we resolved (it may only be present
  // in STREAMIFY_MEDIA_PROXY).
  if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = proxy;
  if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = proxy;

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
