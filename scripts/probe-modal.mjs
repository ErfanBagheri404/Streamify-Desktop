// Inspect the create-playlist overlay: find its close control.
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";

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
    const api = { call: (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; handlers.set(id, { resolve: res, reject: rej }); send({ id, method, params }); }), waitEvent: (method, t = 30000) => new Promise((res, rej) => { const w = { method, resolve: res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error("timeout " + method)); } }, t); }), close: () => sock.end() };
  });
}

const EXPR = `(() => {
  const all = [...document.querySelectorAll('*')];
  const hit = all.find(e => e.children.length < 10 && /Give it a name and description/i.test(e.textContent || ''));
  if (!hit) return 'no-modal-text';
  let root = hit;
  for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
  const btns = [...root.querySelectorAll('button')].map((b, i) => i + '|' + JSON.stringify((b.textContent || '').trim().slice(0, 20)) + '|aria=' + JSON.stringify(b.getAttribute('aria-label')) + '|title=' + JSON.stringify(b.getAttribute('title')));
  const svgs = [...root.querySelectorAll('svg')].slice(0, 8).map(s => 'svg aria=' + JSON.stringify(s.getAttribute('aria-label')) + ' cls=' + (s.getAttribute('class') || '').slice(0, 30));
  return JSON.stringify({ rootTag: root.tagName, cls: (root.className || '').toString().slice(0, 90), buttons: btns, svgs });
})()`;

(async () => {
  const t = await httpJson("http://127.0.0.1:9555/json/list");
  const pg = t.find(x => x.type === "page");
  const ws = await wsConnect(pg.webSocketDebuggerUrl);
  await ws.call("Runtime.enable");
  const r = await ws.call("Runtime.evaluate", { expression: EXPR, returnByValue: true });
  console.log(r.result.value);
  process.exit(0);
})().catch(e => { console.log("FATAL " + e.message); process.exit(1); });
