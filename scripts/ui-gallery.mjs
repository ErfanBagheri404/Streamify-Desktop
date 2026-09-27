// Screenshot gallery: navigate routes, dismiss the create-playlist modal, capture PNG + text.
// Usage: node scripts/ui-gallery.mjs <cdpPort> <baseUrl> <outDir> <route>...
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] || 9555);
const BASE = process.argv[3] || "http://localhost:3000";
const OUTDIR = process.argv[4] || "E:/tmp/gallery";
const ROUTES = process.argv.slice(5);

const httpJson = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej);
  });

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const m = wsUrl.match(/^ws:\/\/([^:/]+):(\d+)(\/.*)$/);
    const [, host, port, pathname] = m;
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(port), host, () =>
      sock.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    );
    let hs = false, buf = Buffer.alloc(0);
    const handlers = new Map(); let msgId = 0; const waiters = [];
    const onFrame = (payload, opcode) => {
      if (opcode !== 1) return;
      let msg; try { msg = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (msg.id && handlers.has(msg.id)) { const h = handlers.get(msg.id); handlers.delete(msg.id); msg.error ? h.reject(new Error(JSON.stringify(msg.error))) : h.resolve(msg.result); }
      else if (msg.method) for (const w of waiters) if (w.method === msg.method) w.resolve(msg.params);
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; hs = true; buf = buf.slice(i + 4); resolve(api); }
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (opcode === 9) sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
        else if (fin) onFrame(payload, opcode);
      }
    });
    sock.on("error", reject);
    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    };
    const api = {
      call: (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; handlers.set(id, { resolve: res, reject: rej }); send({ id, method, params }); }),
      waitEvent: (method, t = 30000) => new Promise((res, rej) => { const w = { method, resolve: res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error("timeout " + method)); } }, t); }),
      close: () => sock.end(),
    };
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (ws, expr) => ws.call("Runtime.evaluate", { expression: expr, returnByValue: true });

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  await ws.call("Runtime.enable");

  for (const route of ROUTES) {
    const loaded = ws.waitEvent("Page.loadEventFired", 25000).catch(() => null);
    await ws.call("Page.navigate", { url: BASE + route });
    await loaded;
    await sleep(5000);

    // dismiss any blocking dialog (create-playlist modal etc.)
    const dismiss = await ev(ws, `(() => {
      const close = document.querySelector('button[aria-label="Close playlist modal"]');
      if (close) { close.click(); return 'clicked:close-modal'; }
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(b => /^(cancel|close|dismiss|no)$/i.test((b.textContent||'').trim()));
      if (!hit) return 'none';
      hit.click();
      return 'clicked:' + (hit.textContent||'').trim().slice(0,20);
    })()`);
    await sleep(1500);

    const shot = await ws.call("Page.captureScreenshot", { format: "png" });
    const name = (route === "/" ? "home" : route.replace(/\//g, "_").replace(/^_/, "")) + ".png";
    fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(shot.data, "base64"));

    const info = await ev(ws, `JSON.stringify({
      url: location.pathname,
      nav: [...document.querySelectorAll('nav a, [role="navigation"] a')].map(a => (a.textContent||'').trim()).filter(Boolean).slice(0,12),
      heading: (document.querySelector('h1,h2')||{}).textContent || '',
      hasPlayer: !!document.querySelector('audio, [class*="player" i]'),
      text: document.body.innerText.replace(/\\s+/g,' ').slice(0,140)
    })`);
    console.log(`${name} <- ${info.result.value}`);
  }
  console.log("OUTDIR " + OUTDIR);
  process.exit(0);
})().catch((e) => { console.log("FATAL " + e.message); process.exit(1); });
