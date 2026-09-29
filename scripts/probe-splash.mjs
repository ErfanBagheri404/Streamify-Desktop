// Renders electron/splash.html in the running app and reports the computed
// geometry + animation, then grabs two frames to prove motion.
// Usage: node scripts/probe-splash.mjs [cdpPort]
import { writeFileSync } from "node:fs";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 9444);
const OUT = new URL("../.logs/", import.meta.url).pathname.replace(/^\//, "");
const WS_URL = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  .then((t) => t.find((x) => x.type === "page").webSocketDebuggerUrl.replace("127.0.0.1", "127.0.0.1"));
const u = new URL(WS_URL);

const sock = net.connect(Number(u.port), u.hostname);
const key = crypto.randomBytes(16).toString("base64");
await new Promise((res) => {
  sock.once("connect", res);
  sock.write(
    `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
});
await new Promise((res) => sock.once("data", res));

let buf = Buffer.alloc(0);
const waiters = new Map();
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 2) return;
    const len0 = buf[1] & 0x7f;
    let off = 2, len = len0;
    if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const msg = JSON.parse(buf.subarray(off, off + len).toString());
    buf = buf.subarray(off + len);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let id = 0;
function send(method, params = {}) {
  const myId = ++id;
  const frame = Buffer.from(JSON.stringify({ id: myId, method, params }));
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(frame.map((b, i) => b ^ mask[i % 4]));
  const head =
    frame.length < 126
      ? Buffer.from([0x81, 0x80 | frame.length])
      : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(frame.length); return b; })()]);
  sock.write(Buffer.concat([head, mask, masked]));
  return new Promise((res) => waiters.set(myId, res));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Page.navigate", { url: "file:///E:/Dev/Projects/Streamify-Desktop/electron/splash.html" });
await sleep(1200);

const expr = `JSON.stringify({
  width: Math.round(document.querySelector('.ld-atom').getBoundingClientRect().width),
  orbits: document.querySelectorAll('.ld-atom-orbit').length,
  rings: document.querySelectorAll('.ld-atom-ring').length,
  shell: !!document.querySelector('.ld-atom-shell'),
  duration: getComputedStyle(document.querySelector('.ld-atom-spin')).animationDuration,
  easing: getComputedStyle(document.querySelector('.ld-atom-spin')).animationTimingFunction,
  opacity: getComputedStyle(document.querySelector('.ld-atom')).opacity,
  delay0: getComputedStyle(document.querySelectorAll('.ld-atom-spin')[0]).animationDelay,
  delay2: getComputedStyle(document.querySelectorAll('.ld-atom-spin')[2]).animationDelay,
  text: (document.body.innerText || '').trim() || '(none)'
})`;
const ev = await send("Runtime.evaluate", { expression: expr });
console.log("COMPUTED:", ev.result.result.value);

for (const name of ["splash-a.png", "splash-b.png"]) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT + name, Buffer.from(shot.result.data, "base64"));
  await sleep(420);
}
console.log("frames written to .logs/splash-a.png + splash-b.png");

await send("Page.navigate", { url: "http://localhost:3000/" });
sock.end();
process.exit(0);
