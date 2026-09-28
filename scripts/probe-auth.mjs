// Focused desktop-auth probe: checks the browser-handoff button renders on
// /signin, clicks it, and reports whether bridge.auth.start() fired.
// Usage: STREAMIFY_DEBUG_PORT=9444 node scripts/probe-auth.mjs
import http from "node:http";

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
            reject(new Error(`bad json from ${url}`));
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

const ws = new WebSocket(page.webSocketDebuggerUrl, {
  maxPayload: 64 * 1024 * 1024,
});
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = false) {
  const { result } = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  return result?.result?.value;
}

// Navigate to /signin inside the app.
await cdp("Page.navigate", { url: "http://localhost:3000/signin" });
await new Promise((r) => setTimeout(r, 4000));

const probe = await evaluate(`({
  bridge: typeof window.streamifyDesktop !== "undefined" && !!window.streamifyDesktop.auth,
  buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
  hasPasswordField: !!document.querySelector('input[type="password"]'),
})`);
console.log("bridge.auth present:", probe?.bridge);
console.log("buttons:", JSON.stringify(probe?.buttons));
console.log("in-app password field rendered:", probe?.hasPasswordField);

// Click "Continue in browser" — bridge.auth.start() is sync IPC to main,
// which opens the OS browser. Pending state should appear in the UI.
const clicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Continue in browser/i.test(x.textContent || ""));
  if (!b) return "not-found";
  b.click();
  return "clicked";
})()`);
console.log("click:", clicked);
await new Promise((r) => setTimeout(r, 2000));
const after = await evaluate(`({
  buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
})`);
console.log("buttons after click:", JSON.stringify(after?.buttons));

ws.close();
process.exit(0);
