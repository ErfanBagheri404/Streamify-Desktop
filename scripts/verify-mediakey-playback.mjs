// Proves the OS media key controls REAL playback: with audio playing, send
// VK_MEDIA_PLAY_PAUSE and confirm the <audio> element pauses, then resumes.
//   STREAMIFY_DEBUG_PORT=9333 node scripts/verify-mediakey-playback.mjs
import http from "node:http";
import { execFileSync } from "node:child_process";

const PORT = Number(process.env.STREAMIFY_DEBUG_PORT || 9333);
const targets = await new Promise((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    })
    .on("error", reject);
});
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let id = 1;
const pending = new Map();
ws.onmessage = (evt) => {
  const m = JSON.parse(String(evt.data));
  if (!m.id || !pending.has(m.id)) return;
  const { resolve, reject } = pending.get(m.id);
  pending.delete(m.id);
  if (m.error) reject(new Error(JSON.stringify(m.error)));
  else resolve(m.result);
};
const cdp = (method, params = {}) => {
  const i = id++;
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
  });
};
const ev = async (expression) => {
  const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return exceptionDetails ? { thrown: "eval error" } : { value: result.value };
};

const audioState = () =>
  ev(
    `(function(){var a=document.querySelector('audio');return a?{paused:a.paused,t:Number(a.currentTime.toFixed(2))}:{missing:true}})()`
  );

const press = () =>
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint f, UIntPtr x); }
"@
[K]::keybd_event(0xB3,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(0xB3,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 900`,
  ]);

await cdp("Runtime.enable");

const before = (await audioState()).value;
if (before?.missing || before.paused) {
  console.log(JSON.stringify({ before, note: "audio not playing — run verify-playback first" }));
  process.exit(1);
}

press();
await new Promise((r) => setTimeout(r, 1200));
const afterPause = (await audioState()).value;

press();
await new Promise((r) => setTimeout(r, 1500));
const afterResume = (await audioState()).value;

ws.close();
console.log(JSON.stringify({ before, afterPause, afterResume }, null, 2));
const ok = afterPause.paused === true && afterResume.paused === false;
console.log(ok ? "\nPASS: OS media key paused and resumed real playback" : "\nFAIL");
process.exit(ok ? 0 : 1);
