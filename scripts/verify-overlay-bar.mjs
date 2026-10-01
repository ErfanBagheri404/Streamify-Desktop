// Verifies the in-window overlay title bar against the running app over CDP:
// the strip exists, the three left buttons are wired, the drag region is set,
// and Back/Forward only walk in-app history (never the boot splash).
// Usage: node scripts/verify-overlay-bar.mjs [port]
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

const bar = `(() => {
  // Scope to the strip itself: the pre-paint script sets the same attribute
  // on <html>, so a bare attribute selector matches the document element.
  const el = document.querySelector('div[data-overlay-bar]');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const buttons = [...el.querySelectorAll('button')].map((b) => ({
    label: b.getAttribute('aria-label'),
    disabled: b.disabled,
    noDrag: getComputedStyle(b.parentElement).webkitAppRegion,
  }));
  return {
    rect: el.getBoundingClientRect().toJSON(),
    position: cs.position,
    zIndex: cs.zIndex,
    drag: cs.webkitAppRegion || el.style.webkitAppRegion,
    buttons,
    navBridge: !!window.streamifyDesktop?.titleBar,
    hasProxyBridge: !!window.streamifyDesktop?.proxy,
    historyLength: history.length,
    href: location.href,
  };
})()`;

console.log("--- overlay bar present ---");
const s = await evalJs(bar);
if (!s) {
  console.log("   FAIL no [data-overlay-title-bar] in the DOM");
  process.exit(1);
}
check("strip rendered", s.rect.height > 20 && s.rect.top === 0, `h=${s.rect.height} top=${s.rect.top}`);
check("fixed + on top", s.position === "fixed" && Number(s.zIndex) >= 90, `${s.position} z=${s.zIndex}`);
check("drag region", (s.drag || "").includes("drag"), s.drag);
check("three buttons", s.buttons.length === 3, s.buttons.map((b) => b.label).join(","));
check("buttons opt out of drag", s.buttons.every((b) => b.noDrag === "no-drag"), JSON.stringify(s.buttons.map((b) => b.noDrag)));
check("titleBar bridge", s.navBridge);
check("proxy bridge", s.hasProxyBridge);
// historyLength is only 1 right after boot, so it is not the invariant. The
// splash is a data: URL entry that main clears in did-finish-load; the check that
// actually holds mid-session is that the current entry is a real app URL (and
// further down, that Back never lands on a non-http URL).
check("current entry is an app URL", s.href.startsWith("http://localhost:3000"), s.href);
console.log("   shot " + (await shot("overlay-bar.png")));

console.log("--- nav chevrons stay inside the app ---");
// Start from a fresh origin so earlier navigations (this script, or a verifier
// that ran before it) cannot leave a forward entry that makes the back/forward
// assertions below meaningless.
const waitForLoad = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      if ((await evalJs("document.readyState")) === "complete") return true;
    } catch {
      // context swapped mid-flight; keep polling
    }
  }
  return false;
};
await evalJs(`location.assign("/")`).catch(() => {});
// Wait for the document to finish loading rather than sleeping: assigning
// again mid-load cancels it and the destination never happens to arrive.
await waitForLoad();
await new Promise((r) => setTimeout(r, 2000));
// Navigate via a real load, then poll for the destination with fresh
// evaluates: a pending Runtime.evaluate is dropped when the context is
// destroyed by navigation, which would hang the whole script.
await evalJs(`location.assign("/search?q=lofi")`).catch(() => {});
const waitFor = async (predicate, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    let value;
    try {
      value = await evalJs("location.href");
    } catch {
      continue; // context swapped mid-flight; retry
    }
    if (predicate(String(value))) return String(value);
  }
  return null;
};
const searchUrl = await waitFor((u) => u.includes("/search"), "search");
check("navigated to /search", !!searchUrl, String(searchUrl));

const afterNav = await evalJs(
  "JSON.stringify({len: history.length, canBack: !!(globalThis.navigation && globalThis.navigation.canGoBack)})"
);
check("history grew", JSON.parse(afterNav).len > 1, afterNav);

// Back must land on an app route — never the boot splash.
await evalJs(`globalThis.navigation.back()`).catch(() => {});
const backUrl = await waitFor((u) => !u.includes("/search"), "back");
check(
  "back returns to the app (not the splash)",
  !!backUrl && backUrl.startsWith("http://localhost:3000"),
  String(backUrl)
);

await evalJs(`globalThis.navigation.forward()`).catch(() => {});
const fwdUrl = await waitFor((u) => u.includes("/search"), "forward");
check("forward works", !!fwdUrl, String(fwdUrl));
console.log("   shot " + (await shot("overlay-bar-search.png")));

console.log(failed ? "\nFAIL" : "\nPASS");
ws.close();
process.exit(failed ? 1 : 0);
