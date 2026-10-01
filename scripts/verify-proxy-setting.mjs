// Verifies the proxy setting end-to-end against the running app over CDP:
// the row exists, the three modes are selectable, the manual URL field appears
// only in manual mode, and main reports restartRequired when the value changes.
// Usage: node scripts/verify-proxy-setting.mjs [port]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 9444);
const outDir = path.join(root, ".logs");
fs.mkdirSync(outDir, { recursive: true });

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

const evalJs = async (expression) => {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  }
  return r.result?.result?.value;
};

const shot = async (name) => {
  const r = await call("Page.captureScreenshot", { format: "png" });
  const p = path.join(outDir, name);
  fs.writeFileSync(p, Buffer.from(r.result.data, "base64"));
  return p;
};

let failed = false;
const check = (label, ok, detail = "") => {
  console.log(`   ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
};

// location.href changes before the new document is swapped in, so waiting on
// the URL alone can evaluate against the outgoing page. Poll for the content.
await evalJs(`location.assign("/settings")`).catch(() => {});
const waitForText = async (needle, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const has = await evalJs(`document.body?.textContent?.includes(${JSON.stringify(needle)})`);
      if (has === true) return true;
    } catch {
      // context swapped mid-flight; retry
    }
  }
  return false;
};
check("settings page rendered", await waitForText("System Integration"));

const row = `(() => {
  const proxyLabel = [...document.querySelectorAll("label, span, div, p")].find(
    (el) => el.children.length === 0 && el.textContent?.trim() === "Proxy"
  );
  if (!proxyLabel) return null;
  const row = proxyLabel.closest("div");
  const chips = [...document.querySelectorAll('button')].filter((b) =>
    ['System', 'Manual', 'Off'].includes(b.textContent?.trim())
  );
  const input = document.querySelector('input[placeholder*="127.0.0.1"]');
  return {
    found: true,
    chipCount: chips.length,
    chips: chips.map((c) => c.textContent.trim()),
    hasInput: !!input,
    bridge: !!window.streamifyDesktop?.proxy,
  };
})()`;

console.log("--- proxy row ---");
const s = await evalJs(row);
if (!s) {
  console.log("   FAIL no Proxy row on the settings page");
  process.exit(1);
}
check("row rendered", s.found);
check("three mode chips", s.chipCount === 3, s.chips.join(","));
check("bridge present", s.bridge);
check("URL field hidden until manual", s.hasInput === false);
console.log("   shot " + (await shot("proxy-system.png")));

console.log("--- manual mode ---");
await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Manual')?.click()`);
await new Promise((r) => setTimeout(r, 1200));
const manual = await evalJs(`(() => ({
  hasInput: !!document.querySelector('input[placeholder*="127.0.0.1"]'),
  apply: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Apply'),
}))()`);
check("URL field appears", manual.hasInput);
check("Apply button appears", manual.apply);

console.log("--- apply a manual proxy ---");
const applied = await evalJs(`(async () => {
  const input = document.querySelector('input[placeholder*="127.0.0.1"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '127.0.0.1:10808');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply')?.click();
  await new Promise((r) => setTimeout(r, 1800));
  // Only visible, leaf-level text counts — a bare textContent scan matches the
  // inlined <script> tags that also contain the string.
  const toast = [...document.querySelectorAll("div, span, p")]
    .filter((e) => e.children.length === 0 && e.offsetParent !== null)
    .map((e) => e.textContent.trim())
    .find((t) => t.includes("Restart Streamify"));
  return { toast: toast || null, inputValue: input.value };
})()`);
check("restart toast shown", !!applied.toast, String(applied.toast));
check("URL field kept the typed value", applied.inputValue === "127.0.0.1:10808", applied.inputValue);
console.log("   shot " + (await shot("proxy-manual.png")));

// The setting lives in userData/proxy.json — read it back through main.
const saved = await evalJs(
  `window.streamifyDesktop.proxy.get().then((c) => JSON.stringify(c))`
);
check("persisted to main", JSON.parse(saved).mode === "manual" && JSON.parse(saved).url.includes("10808"), saved);

console.log("--- back to system ---");
await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'System')?.click()`);
await new Promise((r) => setTimeout(r, 1200));
const back = await evalJs(`(() => ({
  hasInput: !!document.querySelector('input[placeholder*="127.0.0.1"]'),
}))()`);
check("URL field hidden again", back.hasInput === false);

console.log(failed ? "\nFAIL" : "\nPASS");
ws.close();
process.exit(failed ? 1 : 0);
