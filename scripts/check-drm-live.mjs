// Decisive end-to-end DRM test: load the SoundCloud DRM track's encrypted
// stream with shaka inside the live app page (SW_SECURE_CRYPTO, license via
// /api/license-proxy — the exact AudioContext path that produced 6001 on
// stock Electron) and prove decryption by playing and watching time advance.
const port = Number(process.argv[2] || 9444);

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((p) => p.type === "page" && p.url.includes("localhost:3000")) || pages[0];
if (!page) { console.error("no page"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let _id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++_id; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    .result?.result?.value;

const verdict = await evaluate(`(async () => {
  const out = { steps: [], t0: Date.now() };
  const step = (s) => out.steps.push(s + '@' + Math.round((Date.now() - out.t0) / 1000) + 's');
  const race = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timeout')), ms))]);
  try {
    step('resolve');
    const r = await fetch('/api/video?id=2148966966&source=soundcloud');
    const t = await r.json();
    out.title = t.title;
    out.audioType = t.audioType;
    const license = t.drmLicenseUrl;
    out.licenseKind = license.startsWith('/api/license-proxy') ? 'already-proxied' : 'wrapped';
    const proxied = out.licenseKind === 'wrapped' ? '/api/license-proxy?url=' + encodeURIComponent(license) : license;

    const shaka = window.shaka;
    if (!shaka) { out.error = 'shaka not injected'; return out; }
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) { out.error = 'not supported'; return out; }
    step('shaka-ready');

    // <audio>, not <video>: Chromium power-suspends video-only background
    // media, which is what blocked playback in the earlier runs.
    const media = document.createElement('audio');
    media.style.cssText = 'position:fixed;left:8px;bottom:8px;width:48px;z-index:99999;opacity:0.5';
    document.body.appendChild(media);

    const player = new shaka.Player();
    await player.attach(media);
    player.configure({
      drm: {
        servers: { 'com.widevine.alpha': new URL(proxied, location.origin).toString() },
        advanced: { 'com.widevine.alpha': { videoRobustness: ['SW_SECURE_CRYPTO'], audioRobustness: ['SW_SECURE_CRYPTO'] } },
        retryParameters: { maxAttempts: 1 },
      },
      streaming: { retryParameters: { maxAttempts: 2 } },
      abr: { enabled: false },
    });

    let shakaErr = null;
    player.addEventListener('error', (e) => {
      shakaErr = { code: e.detail?.code, category: e.detail?.category, msg: String(e.detail?.message || '').slice(0, 160) };
    });
    const keyEvents = [];
    media.addEventListener('encrypted', () => keyEvents.push('encrypted'));
    media.addEventListener('waiting', () => keyEvents.push('waiting'));

    step('load-begin');
    try {
      await race(player.load(t.audioUrl), 30000, 'load');
      out.loaded = true;
    } catch (e) {
      out.loaded = false;
      out.loadError = { msg: String(e.message || e).slice(0, 220), code: e.code ?? null };
    }
    step('load-done loaded=' + out.loaded);
    if (shakaErr) out.shakaError = shakaErr;

    if (out.loaded) {
      out.duration = media.duration;
      out.vis = { hidden: document.hidden, state: document.visibilityState };
      step('play-begin');
      try {
        await race(media.play(), 8000, 'play');
      } catch (e) { out.playStartError = String(e.message || e).slice(0, 160); }
      // poll: advancing currentTime on encrypted content == CDM decrypted it
      for (let i = 0; i < 4; i++) {
        await new Promise((res) => setTimeout(res, 1200));
        out['t' + i] = { ct: Math.round(media.currentTime * 100) / 100, paused: media.paused, rs: media.readyState };
      }
      step('poll-done');
    }

    out.keyEvents = keyEvents.slice(0, 10);
    if (shakaErr) out.shakaError = shakaErr;
    try { await race(player.destroy(), 5000, 'destroy'); } catch { out.destroyHung = true; }
    media.remove();
    step('cleanup-done');
    return out;
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
    return out;
  }
})()`);

console.log(JSON.stringify(verdict, null, 2));
ws.close();
process.exit(0);
