// Verifies the OS caption buttons follow the app theme.
//
// The renderer reads the resolved --background/--foreground and sends them over
// the bridge; main feeds them to setTitleBarOverlay and logs the pair as
// "[theme] mode=... bg=... fg=...". contextBridge objects are frozen, so the
// renderer side cannot be monkey-patched — assertions run against that log
// line, which is the value main actually applies.
//
// Theme card labels are localised, so nothing matches on a theme name: the grid
// is the row of aria-pressed buttons under the "Theme" setting.
// Usage: node scripts/verify-caption-theme.mjs [port]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 9444);
const outDir = path.join(root, ".logs");
const appLog = path.join(outDir, "app.log");
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
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
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

const rgb = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luma = (hex) => {
  const c = rgb(hex);
  if (!c) return null;
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
};
const isLight = (hex) => {
  const l = luma(hex);
  return l === null ? false : l > 0.6;
};
const isDark = (hex) => {
  const l = luma(hex);
  return l === null ? false : l < 0.4;
};

// Latest "[theme]" line main has applied.
const themeLines = () => {
  if (!fs.existsSync(appLog)) return [];
  return fs
    .readFileSync(appLog, "utf8")
    .split("\n")
    .filter((l) => l.includes("[theme]"))
    .map((l) => {
      const m = /mode=(\S+) bg=(\S+) fg=(\S+)/.exec(l);
      return m ? { mode: m[1], bg: m[2], fg: m[3], raw: l.trim() } : null;
    })
    .filter(Boolean);
};
// Waits until main logs a [theme] entry newer than `seen`, then returns it.
const waitTheme = async (seen) => {
  for (let i = 0; i < 40; i++) {
    const all = themeLines();
    if (all.length > seen) return all[all.length - 1];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};

const readTheme = `(() => {
  const s = getComputedStyle(document.documentElement);
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.themeMode,
    background: s.getPropertyValue("--background").trim(),
    foreground: s.getPropertyValue("--foreground").trim(),
  });
})()`;

// Theme cards are the only aria-pressed buttons with a text label; the settings
// page also renders toggle switches with aria-pressed, so filter on that.
const swatches = `(() => {
  const all = [...document.querySelectorAll('button[aria-pressed]')].filter((b) => b.textContent.trim().length > 0);
  const pressed = all.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
  return JSON.stringify({ count: all.length, pressedIndex: pressed, labels: all.map((b) => b.textContent.trim().slice(0, 16)) });
})()`;

const pick = (index) => `(async () => {
  const all = [...document.querySelectorAll('button[aria-pressed]')].filter((b) => b.textContent.trim().length > 0);
  const b = all[${index}];
  if (!b) return 'missing';
  b.click();
  await new Promise((r) => setTimeout(r, 1200));
  return 'clicked';
})()`;

// Get onto settings; location.assign changes the document under us, so poll for
// content instead of reading straight after the call.
await evalJs(`location.assign("/settings")`).catch(() => {});
let ready = false;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    if (JSON.parse(await evalJs(swatches)).count > 3) {
      ready = true;
      break;
    }
  } catch {}
}
check("settings page with theme cards", ready);
if (!ready) {
  console.log("\nFAIL");
  process.exit(1);
}

const grid = JSON.parse(await evalJs(swatches));
console.log(`   ${grid.count} theme cards, current = #${grid.pressedIndex} "${grid.labels[grid.pressedIndex]}"`);

console.log("--- current palette ---");
// The active theme is logged at boot, before this script starts, so the baseline
// is the last line already in the log — not a new one.
const darkLog = themeLines().at(-1) || null;
const darkIdx = grid.pressedIndex;
await evalJs(pick(darkIdx));
// Clicking the already-active theme is a no-op, so main may not re-log here;
// the boot line above is the authoritative record of the current palette.
await waitTheme(themeLines().length);
const darkBase = JSON.parse(await evalJs(readTheme));
check("main received a [theme] payload", !!darkLog, darkLog ? darkLog.raw : "no log line");
if (darkLog) {
  check("payload background is a hex", /^#[0-9a-f]{6}$/i.test(darkLog.bg), darkLog.bg);
  check("payload foreground is a hex", /^#[0-9a-f]{6}$/i.test(darkLog.fg), darkLog.fg);
  check(
    "payload matches the resolved CSS vars",
    darkLog.bg.toLowerCase() === darkBase.background.toLowerCase() && darkLog.fg.toLowerCase() === darkBase.foreground.toLowerCase(),
    `log=${darkLog.bg}/${darkLog.fg} css=${darkBase.background}/${darkBase.foreground}`
  );
  check("payload mode matches the DOM", darkLog.mode === darkBase.mode, `${darkLog.mode} vs ${darkBase.mode}`);
}
console.log(`   theme=${darkBase.theme} mode=${darkBase.mode} bg=${darkBase.background} fg=${darkBase.foreground}`);
console.log("   shot " + (await shot("caption-dark.png")));

console.log("--- find a light palette ---");
let lightTheme = null;
let lightLog = null;
for (let i = 0; i < grid.count; i++) {
  const before = themeLines().length;
  await evalJs(pick(i));
  const probe = JSON.parse(await evalJs(readTheme));
  if (probe.mode === "light") {
    lightTheme = probe;
    lightLog = await waitTheme(before);
    break;
  }
}
check("a light palette exists", !!lightTheme, lightTheme ? lightTheme.theme : "none found");
if (lightTheme) {
  check("light background is light", isLight(lightTheme.background), lightTheme.background);
  check("light foreground is dark", isDark(lightTheme.foreground), lightTheme.foreground);
  check("caption payload followed", !!lightLog, lightLog ? lightLog.raw : "no log line");
  if (lightLog && darkLog) {
    check("caption background changed with the theme", lightLog.bg.toLowerCase() !== darkLog.bg.toLowerCase(), `${darkLog.bg} -> ${lightLog.bg}`);
    check("caption background now matches the light CSS var", lightLog.bg.toLowerCase() === lightTheme.background.toLowerCase(), `${lightLog.bg} vs ${lightTheme.background}`);
    check("caption mode now light", lightLog.mode === "light", lightLog.mode);
  }
  console.log(`   theme=${lightTheme.theme} mode=${lightTheme.mode} bg=${lightTheme.background} fg=${lightTheme.foreground}`);
  console.log("   shot " + (await shot("caption-light.png")));
}

console.log("--- restore the original palette ---");
await evalJs(pick(darkIdx));
await new Promise((r) => setTimeout(r, 900));
const restored = JSON.parse(await evalJs(readTheme));
check("restored", restored.theme === darkBase.theme, `${darkBase.theme} -> ${restored.theme}`);
check(
  "payload restored too",
  darkLog && restored.background.toLowerCase() === darkLog.bg.toLowerCase(),
  `${restored.background} vs ${darkLog?.bg}`
);
console.log("   shot " + (await shot("caption-restored.png")));

console.log(failed ? "\nFAIL" : "\nPASS");
ws.close();
process.exit(failed ? 1 : 0);
