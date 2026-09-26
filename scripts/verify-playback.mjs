// End-to-end playback check against the running desktop app: type a search,
// open a result, hit play, and confirm an <audio> element actually receives a
// source and advances. This is the one behaviour that proves the whole stack
// (Next UI -> in-process API -> upstream -> renderer) works.
//
// Usage: STREAMIFY_DEBUG_PORT=9333 node scripts/verify-playback.mjs
import http from "node:http";

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
const apiCalls = [];
ws.onmessage = (evt) => {
  const m = JSON.parse(String(evt.data));
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params.request.url;
    if (u.includes("127.0.0.1:7861")) apiCalls.push(u.replace(/^http:\/\/127\.0\.0\.1:7861/, ""));
  }
};

const cdp = (method, params = {}) => {
  const i = id++;
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 90000);
  });
};

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return exceptionDetails ? { thrown: exceptionDetails.exception?.description } : { value: result.value };
};

await cdp("Runtime.enable");
await cdp("Network.enable");
await cdp("Page.enable");

const report = { steps: [] };

// 1. Land on search.
await cdp("Page.navigate", { url: "http://localhost:3000/search?q=daft+punk&source=youtube" });
await new Promise((r) => setTimeout(r, 9000));
report.steps.push({
  step: "search page",
  results: (await evaluate(`document.querySelectorAll('a[href*="/artist"], button').length`)).value,
  bodyLen: (await evaluate(`document.body.innerText.length`)).value,
});

// 2. Click the first song row. Rows render as plain buttons whose aria labels
// are localized and carry no stable hook, so target the songs section by its
// heading instead of matching text.
const clicked = await evaluate(`
  (function () {
    var headings = Array.from(document.querySelectorAll('h1,h2,h3'));
    var root = document;
    for (var i = 0; i < headings.length; i++) {
      if (/songs/i.test(headings[i].innerText || '')) { root = headings[i].parentElement; break; }
    }
    var btn = root.querySelector('button');
    if (!btn) return 'no button inside songs section';
    btn.click();
    return 'clicked: ' + ((btn.getAttribute('aria-label') || '').slice(0, 60));
  })()`);
report.steps.push({ step: "click play", result: clicked.value ?? clicked.thrown });

// 3. Watch for an <audio> element to get a source and advance.
let audio = null;
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  audio = (
    await evaluate(`
      (function () {
        var a = document.querySelector('audio');
        if (!a) return { present: false };
        return {
          present: true,
          src: (a.currentSrc || a.src || '').slice(0, 90),
          readyState: a.readyState,
          paused: a.paused,
          currentTime: Number(a.currentTime.toFixed(2)),
          duration: Number((a.duration || 0).toFixed(2)),
          error: a.error ? a.error.code : null,
        };
      })()`)
  ).value;
  if (audio?.present && audio.currentTime > 0.5) break;
}

report.audio = audio;
report.inProcessApiCalls = [...new Set(apiCalls)].slice(0, 15);
ws.close();
console.log(JSON.stringify(report, null, 2));

const played = audio?.present && audio.currentTime > 0.5;
console.log(
  played
    ? `\nPASS: audio playing (t=${audio.currentTime}s, duration=${audio.duration}s)`
    : "\nFAIL: no advancing audio element"
);
process.exit(played ? 0 : 1);
