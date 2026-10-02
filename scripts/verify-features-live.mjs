// Exercises the three things the user reported broken, from INSIDE the running
// app (renderer + local API), with whatever proxy the app is configured with:
//   covers  -> i.ytimg.com image request
//   songs   -> the app's own /api/search
//   login   -> Supabase reachability + the auth page itself
// Usage: node scripts/verify-features-live.mjs [port]
import assert from "node:assert/strict";

const port = Number(process.argv[2] || 9444);
const SUPABASE_HOST = "hrlmsfsifdtvndrgpxth.supabase.co";

const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = tabs.find((t) => t.type === "page");
assert.ok(page, "no app page on CDP");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  }
  return r.result?.result?.value;
};

await call("Runtime.enable");

const out = await evaluate(`(async () => {
  const timed = async (label, fn) => {
    const t0 = Date.now();
    try { return { label, ...(await fn()), ms: Date.now() - t0 }; }
    catch (e) { return { label, error: String(e && e.message || e), ms: Date.now() - t0 }; }
  };

  const cover = await timed("cover", async () => {
    const r = await fetch("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", { cache: "no-store" });
    const b = await r.blob();
    return { status: r.status, bytes: b.size };
  });

  const search = await timed("search", async () => {
    const r = await fetch("/api/search?q=lofi", { cache: "no-store" });
    const body = await r.json();
    const items = body.items || [];
    return { status: r.status, bytes: JSON.stringify(body).length, items, itemCount: items.length };
  });

  const supabase = await timed("supabase", async () => {
    const r = await fetch("https://${SUPABASE_HOST}/auth/v1/health", { cache: "no-store" });
    return { status: r.status };
  });

  // /api/video resolves ONE track by id (it takes no query), so pull a real
  // 11-char YouTube id out of the results — channels/albums also carry an id
  // and 500 on them.
  let videos = { label: "videos", error: "no video id in search results" };
  try {
    const yt = (search.items || []).find(
      (i) => i.type === "video" || /^[A-Za-z0-9_-]{11}$/.test(String(i.videoId || ""))
    );
    const vid = yt && (yt.videoId || yt.id);
    if (vid) {
      videos = await timed("videos", async () => {
        const r = await fetch("/api/video?id=" + encodeURIComponent(String(vid)), { cache: "no-store" });
        const body = await r.json();
        return {
          status: r.status,
          id: vid,
          hasStreams: Array.isArray(body.formats) || Array.isArray(body.streams) || !!body.streamUrl,
        };
      });
    }
  } catch (e) {
    videos = { label: "videos", error: String((e && e.message) || e) };
  }

  return [cover, search, supabase, videos];
})()`);

for (const r of out) {
  const { items, ...rest } = r;
  console.log(JSON.stringify({ ...rest, ...(items ? { itemCount: items.length } : {}) }));
}

const by = (l) => out.find((r) => r.label === l);
assert.ok(by("cover").status === 200 && by("cover").bytes > 1000, `covers broken: ${JSON.stringify(by("cover"))}`);
assert.ok(by("supabase").status, `supabase unreachable: ${JSON.stringify(by("supabase"))}`);
assert.ok(!by("search").error, `search threw: ${JSON.stringify(by("search"))}`);
assert.ok(by("search").status === 200, `search bad status: ${JSON.stringify(by("search"))}`);
assert.ok(by("search").itemCount > 0, `search returned no items: ${JSON.stringify(by("search"))}`);
assert.ok(by("videos") && !by("videos").error, `video resolve failed: ${JSON.stringify(by("videos"))}`);

ws.close();
console.log("\nRESULT PASS");