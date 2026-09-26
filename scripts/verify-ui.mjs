// Phase 6 parity walk: drives the running app over CDP, visits every route, and
// reports console errors plus whether the page actually rendered content.
//
// Usage: STREAMIFY_DEBUG_PORT=9333 node scripts/verify-ui.mjs
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
const consoleErrors = [];
const pageErrors = [];

ws.onmessage = (evt) => {
  const msg = JSON.parse(String(evt.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push((msg.params.exceptionDetails.exception?.description || "").slice(0, 300));
  }
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
    }, 60000);
  });
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    return { thrown: (exceptionDetails.exception?.description || "").slice(0, 300) };
  }
  return { value: result.value };
}

await cdp("Runtime.enable");
await cdp("Page.enable");

const routes = [
  "/",
  "/search",
  "/library",
  "/settings",
  "/signin",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/session",
  "/session/privacy",
  "/session/terms",
  "/artist/FGBhQbmPwH8",
  "/artist/channel/FGBhQbmPwH8",
  "/collection/tracks/1",
  "/session/abc123",
];

const results = [];
for (const route of routes) {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  await cdp("Page.navigate", { url: `http://localhost:3000${route}` });
  await new Promise((r) => setTimeout(r, 4000));
  const probe = await evaluate(`({
    title: document.title,
    bodyLen: document.body ? document.body.innerText.length : 0,
    hasSidebar: Boolean(document.querySelector('nav, aside, [class*="sidebar" i]')),
    theme: document.documentElement.dataset.theme || null,
    dir: document.documentElement.dir || null,
  })`);
  results.push({
    route,
    ...(probe.value || { thrown: probe.thrown }),
    consoleErrors: [...consoleErrors],
    pageErrors: [...pageErrors],
  });
}

ws.close();
console.log(JSON.stringify(results, null, 2));

const failed = results.filter(
  (r) => r.thrown || r.pageErrors?.length || r.bodyLen < 50
);
console.log(
  failed.length === 0
    ? `\nPASS: all ${results.length} routes rendered`
    : `\nFAIL: ${failed.length} route(s) broken: ${failed.map((f) => f.route).join(", ")}`
);
process.exit(failed.length === 0 ? 0 : 1);
