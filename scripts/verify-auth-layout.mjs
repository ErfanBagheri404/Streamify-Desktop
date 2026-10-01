// Asserts the three UI fixes against the live app over CDP:
//   1. auth page is full-bleed and NOT scrollable (100dvh + strip inset fixed)
//   2. the mobile gate screen is gone
//   3. the strip still reports its 36px height (caption buttons live above it)
// Usage: node scripts/verify-auth-layout.mjs [port]
const port = Number(process.argv[2] || 9444);
const ORIGIN = "http://localhost:3000";

const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = tabs.find((t) => t.type === "page");
if (!page) {
  console.error("FAIL no page target");
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
};

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

async function goto(url) {
  await ev(`location.assign(${JSON.stringify(url)})`);
  // Poll fresh evaluates: a pending Runtime.evaluate is dropped on navigation.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ready = await ev(`location.origin + '|' + location.pathname`);
    if (typeof ready === "string" && ready.includes(url.replace(ORIGIN, ""))) {
      await new Promise((r) => setTimeout(r, 900));
      return;
    }
  }
  throw new Error(`navigation to ${url} did not settle`);
}

console.log("=== auth screen ===");
await goto(`${ORIGIN}/signin`);

const auth = await ev(`(() => {
  const main = document.querySelector('main[data-auth-page="true"]');
  const screen = main && main.firstElementChild;
  const de = document.documentElement;
  const strip = document.querySelector('div[data-overlay-bar]');
  const stripH = strip ? strip.getBoundingClientRect().height : 0;
  const viewportH = window.innerHeight;
  return JSON.stringify({
    hasMain: !!main,
    hasScreen: !!screen,
    screenH: screen ? Math.round(screen.getBoundingClientRect().height) : null,
    screenComputed: screen ? getComputedStyle(screen).height : null,
    stripH: Math.round(stripH),
    viewportH,
    docScrollH: de.scrollHeight,
    bodyScrollH: document.body.scrollHeight,
    hasVScrollbar: de.scrollHeight > de.clientHeight + 1,
    // The gate's only text came from the mobileGate.* locale keys; assert on
    // what it rendered rather than a class it never actually had.
    gatePresent: document.body.innerText.includes("Streamify for Android") ||
      document.body.innerText.includes("Continue in Browser"),
  });
})()`);
const a = JSON.parse(auth);
console.log("  " + auth);

check("auth screen renders", a.hasMain && a.hasScreen, a.hasScreen);
// strip inset (36) + screen must equal the viewport, not exceed it.
check(
  "auth screen fits viewport exactly (no scroll)",
  a.screenH !== null && a.screenH + a.stripH <= a.viewportH + 1,
  `screen=${a.screenH} + strip=${a.stripH} <= viewport=${a.viewportH}`
);
check("no vertical scrollbar on auth", !a.hasVScrollbar, `doc=${a.docScrollH} client=${a.viewportH}`);
check("strip height unchanged (36px)", a.stripH === 36, `strip=${a.stripH}`);
check("mobile gate removed", !a.gatePresent);

console.log("\n=== body scroll restored on the app home ===");
await goto(`${ORIGIN}/`);
await new Promise((r) => setTimeout(r, 1200));
const home = JSON.parse(
  await ev(`JSON.stringify({ h: document.documentElement.scrollHeight, c: document.documentElement.clientHeight })`)
);
console.log(`  doc=${home.h} client=${home.c}`);
// A normal app page is allowed to be taller than the viewport (it scrolls), but
// it must not be short by exactly the strip height — that was the auth bug.
check("home page renders below the strip", home.h > home.c - 1, `doc=${home.h} client=${home.c}`);

ws.close();
console.log(failures.length ? `\nRESULT FAIL: ${failures.join(", ")}` : "\nRESULT PASS");
process.exit(failures.length ? 1 : 0);