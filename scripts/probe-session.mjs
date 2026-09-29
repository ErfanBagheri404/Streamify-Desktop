// Probe supabase session state inside the running desktop app.
// Usage: STREAMIFY_DEBUG_PORT=9444 node scripts/probe-session.mjs
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

const state = await evaluate(`(() => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith("sb-"));
  const sessions = keys.map((k) => {
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(k)); } catch {}
    return {
      key: k,
      hasAccess: !!parsed?.access_token,
      hasRefresh: !!parsed?.refresh_token,
      expiresAt: parsed?.expires_at,
      nowSec: Math.floor(Date.now() / 1000),
      userId: parsed?.user?.id || null,
      email: parsed?.user?.email || null,
    };
  });
  return { url: location.href, sessions };
})()`);
console.log(JSON.stringify(state, null, 2));

ws.close();
process.exit(0);
