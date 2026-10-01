// Switches the app to the first light theme (or back to a dark one) so the
// caption strip can be screenshotted in both states.
// Usage: node scripts/set-theme-mode.mjs <light|dark> [port]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const want = process.argv[2] || "light";
const port = Number(process.argv[3] || 9444);

const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = tabs.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}
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
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const ev = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await ev('location.assign("/settings")').catch(() => {});
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    if (JSON.parse(await ev("(()=>{const a=[...document.querySelectorAll('button[aria-pressed]')];return JSON.stringify({n:a.length});})()")).n > 3) break;
  } catch {}
}
// Theme card labels are localised, so pick by the mode each card applies:
// click cards until data-theme-mode matches what we want.
const wantMode = want === "light" ? "light" : "dark";
const labels = JSON.parse(
  await ev("(()=>{const a=[...document.querySelectorAll('button[aria-pressed]')];return JSON.stringify(a.map((b,i)=>({i,pressed:b.getAttribute('aria-pressed'),text:b.textContent.trim().slice(0,14)})));})()")
);
let done = false;
for (const card of labels) {
  await ev(`(()=>{const a=[...document.querySelectorAll('button[aria-pressed]')];a[${card.i}]?.click();return 1;})()`);
  // React applies the dataset after the click, so wait for it to settle.
  await new Promise((r) => setTimeout(r, 700));
  const state = JSON.parse(
    await ev("JSON.stringify({m:document.documentElement.dataset.themeMode,t:document.documentElement.dataset.theme})")
  );
  if (state.m === wantMode) {
    console.log(`applied theme=${state.t} mode=${state.m} (card #${card.i} "${card.text}")`);
    done = true;
    break;
  }
}
if (!done) console.log(`no card produced mode=${wantMode}`);
await new Promise((r) => setTimeout(r, 1200));
console.log(
  await ev(
    "JSON.stringify({theme:document.documentElement.dataset.theme,mode:document.documentElement.dataset.themeMode,bg:getComputedStyle(document.documentElement).getPropertyValue('--background').trim()})"
  )
);
ws.close();
