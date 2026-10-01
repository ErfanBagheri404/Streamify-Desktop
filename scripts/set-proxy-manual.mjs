// Puts the proxy row into manual mode (so the URL field is visible), then
// delegates to shot-proxy-row.mjs for the screenshot.
const port = Number(process.argv[2] || 9444);
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = tabs.find((t) => t.type === "page");
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

// Ensure we are on settings and pick Manual so the input renders.
const onSettings = await evalJs(`document.body?.textContent?.includes("System Integration")`);
if (!onSettings) {
  await evalJs(`location.assign("/settings")`).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if (await evalJs(`document.body?.textContent?.includes("System Integration")`)) break;
    } catch {}
  }
}
await evalJs(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Manual")?.click()`);
await new Promise((r) => setTimeout(r, 1200));
console.log("manual mode selected");
ws.close();
process.exit(0);
