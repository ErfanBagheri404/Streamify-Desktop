// Probe: navigate to each route and report final URL + visible text + errors.
// Usage: node scripts/route-probe.mjs <cdpPort> <baseUrl> <route> [<route>...]
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.argv[2] || 9555);
const BASE = process.argv[3] || "http://localhost:3000";
const ROUTES = process.argv.slice(4);

const httpJson = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
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
    const handlers = new Map(); let msgId = 0;
    const waiters = [];
    const onFrame = (payload, opcode) => {
      if (opcode !== 1) return;
      let msg; try { msg = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (msg.id && handlers.has(msg.id)) {
        const h = handlers.get(msg.id); handlers.delete(msg.id);
        msg.error ? h.reject(new Error(JSON.stringify(msg.error))) : h.resolve(msg.result);
      } else if (msg.method) {
        for (const w of waiters) if (w.method === msg.method) w.resolve(msg.params);
      }
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        hs = true; buf = buf.slice(i + 4); resolve(api);
      }
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
      waitEvent: (method, timeoutMs = 20000) => new Promise((res, rej) => {
        const w = { method, resolve: res }; waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error("timeout " + method)); } }, timeoutMs);
      }),
      close: () => sock.end(),
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  await ws.call("Runtime.enable");
  await ws.call("Log.enable");

  const errors = [];
  const orig = ws.call.bind(ws);
  ws.call = async (m, p) => {
    const r = await orig(m, p);
    if (m === "Runtime.evaluate" && r && r.exceptionDetails) errors.push(r.exceptionDetails.text);
    return r;
  };
  // collect console errors
  (async () => {
    for (;;) {
      try { const e = await ws.waitEvent("Log.entryAdded", 60000); if (e.entry.level === "error") errors.push(e.entry.text.slice(0, 160)); } catch { break; }
    }
  })();

  for (const route of ROUTES) {
    const loaded = ws.waitEvent("Page.loadEventFired", 25000).catch(() => null);
    await ws.call("Page.navigate", { url: BASE + route });
    await loaded;
    await sleep(4500);
    const r = await ws.call("Runtime.evaluate", {
      expression: `JSON.stringify({ url: location.pathname + location.search, title: document.title, h: (document.querySelector('main')||document.body).innerText.replace(/\\s+/g,' ').slice(0,220) })`,
      returnByValue: true,
    });
    console.log(`ROUTE ${route} -> ${r.result.value}`);
  }
  console.log("ERRORS " + JSON.stringify(errors.slice(0, 8)));
  ws.close(); process.exit(0);
})().catch((e) => { console.log("FATAL " + e.message); process.exit(1); });
