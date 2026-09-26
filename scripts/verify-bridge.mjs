// Verifies the Phase 5 desktop bridge end to end against the RUNNING app:
//   1. window.streamifyDesktop exists         -> preload + contextBridge ran
//   2. a real OS media-key press is captured  -> globalShortcut -> IPC -> page
//
// The press is delivered by Windows itself (keybd_event, VK_MEDIA_PLAY_PAUSE),
// so this exercises the same path a keyboard's media key uses.
//
// Usage: STREAMIFY_DEBUG_PORT=9333 node scripts/verify-bridge.mjs
import http from "node:http";
import { execFileSync } from "node:child_process";

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`bad json from ${url}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

const CDP_PORT = Number(process.env.STREAMIFY_DEBUG_PORT || 9222);
const tabs = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
const page = tabs.find((t) => t.url?.includes("localhost:3000"));
if (!page) {
  console.error(`no app tab among ${tabs.length} CDP targets`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (evt) => {
  const msg = JSON.parse(String(evt.data));
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(JSON.stringify(msg.error)));
  else resolve(msg.result);
};

function cdp(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (exceptionDetails) {
    return { thrown: (exceptionDetails.exception?.description || "").slice(0, 300) };
  }
  return { value: result.value };
}

const report = {};

report.bridgeExists = (await evaluate(`Boolean(window.streamifyDesktop?.isDesktop)`)).value;

// Subscribe inside the page and record every command the main process forwards.
report.subscribe = (
  await evaluate(`
    (function () {
      window.__desktopCmds = [];
      window.__desktopSubscribed = false;
      try {
        window.streamifyDesktop.onCommand(function (cmd) {
          window.__desktopCmds.push(cmd);
        });
        window.__desktopSubscribed = true;
      } catch (e) {
        return "threw: " + String((e && e.message) || e);
      }
      return true;
    })()`)
).value;

// Real OS-level media key. keybd_event VK_MEDIA_PLAY_PAUSE = 0xB3,
// KEYEVENTF_KEYUP = 0x0002.
execFileSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  `
  Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class K {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  }
"@
  [K]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [K]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
  `,
]);

await new Promise((r) => setTimeout(r, 1500));
report.commandsReceived = (await evaluate(`window.__desktopCmds`)).value;

ws.close();
console.log(JSON.stringify(report, null, 2));
const ok = report.bridgeExists === true && (report.commandsReceived || []).includes("play-pause");
console.log(ok ? "\nPASS: media key reached the renderer" : "\nFAIL: bridge did not deliver the command");
process.exit(ok ? 0 : 1);
