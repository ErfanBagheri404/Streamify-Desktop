// Click a real collection row (div[role=button]) and verify audio plays.
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.argv[2] || 9555);
const httpJson = (u) => new Promise((res, rej) => { http.get(u, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); });

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const m = wsUrl.match(/^ws:\/\/([^:/]+):(\d+)(\/.*)$/);
    const [, host, port, pathname] = m;
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(port), host, () => sock.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let hs = false, buf = Buffer.alloc(0);
    const handlers = new Map(); let msgId = 0; const waiters = [];
    const onFrame = (p, op) => { if (op !== 1) return; let msg; try { msg = JSON.parse(p.toString("utf8")); } catch { return; } if (msg.id && handlers.has(msg.id)) { const h = handlers.get(msg.id); handlers.delete(msg.id); msg.error ? h.reject(new Error(JSON.stringify(msg.error))) : h.resolve(msg.result); } else if (msg.method) for (const w of waiters) if (w.method === msg.method) w.resolve(msg.params); };
    sock.on("data", c => {
      buf = Buffer.concat([buf, c]);
      if (!hs) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; hs = true; buf = buf.slice(i + 4); resolve(api); }
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const p = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 9) sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
        else if (fin) onFrame(p, op);
      }
    });
    sock.on("error", reject);
    const send = o => { const p = Buffer.from(JSON.stringify(o)); const mask = crypto.randomBytes(4); let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); } const m = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i % 4]; sock.write(Buffer.concat([h, mask, m])); };
    const api = { call: (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; handlers.set(id, { resolve: res, reject: rej }); send({ id, method, params }); }), waitEvent: (method, t = 40000) => new Promise((res, rej) => { const w = { method, resolve: res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error("timeout " + method)); } }, t); }), close: () => sock.end() };
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const t = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const pg = t.find(x => x.type === "page");
  const ws = await wsConnect(pg.webSocketDebuggerUrl);
  await ws.call("Runtime.enable");
  await ws.call("Network.enable");
  const ev = (expr) => ws.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r => r.result.value);

  const apiCalls = [];
  (async () => {
    for (;;) {
      try {
        const e = await ws.waitEvent("Network.requestWillBeSent", 60000);
        const u = e.request.url;
        if (u.includes("7861")) apiCalls.push(u.replace(/^http:\/\/127\.0\.0\.1:7861/, "").slice(0, 110));
      } catch { break; }
    }
  })();

  const rows = await ev(`JSON.stringify([...document.querySelectorAll('div[role="button"]')].map(d => (d.textContent||'').replace(/\\s+/g,' ').trim().slice(0,50)).filter(Boolean).slice(0,8))`);
  console.log("collection rows:", rows);

  const played = await ev(`(() => {
    const rows = [...document.querySelectorAll('div[role="button"]')];
    const row = rows.find(d => /Get Lucky/i.test(d.textContent||''));
    if (!row) return 'no-row';
    row.click();
    return 'clicked row: ' + (row.textContent||'').replace(/\\s+/g,' ').trim().slice(0,50);
  })()`);
  console.log("play:", played);

  for (let i = 0; i < 4; i++) {
    await sleep(7000);
    const a = await ev(`(() => { const a = document.querySelector('audio'); return a ? JSON.stringify({src:(a.currentSrc||a.src||'').slice(0,95), readyState:a.readyState, paused:a.paused, t:+a.currentTime.toFixed(2), dur:Number.isFinite(a.duration)?+a.duration.toFixed(1):null, err:a.error&&a.error.code}) : 'no-audio'; })()`);
    console.log("audio" + (i+1) + ":", a);
  }
  console.log("API CALLS:", JSON.stringify([...new Set(apiCalls)].slice(0, 10), null, 1));
  process.exit(0);
})().catch(e => { console.log("FATAL " + e.message); process.exit(1); });
