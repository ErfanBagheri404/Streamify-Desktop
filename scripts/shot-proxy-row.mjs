// Scrolls the proxy row into view and screenshots it.
const port = Number(process.argv[2] || 9444);
const out = process.argv[3] || "E:/Dev/Projects/Streamify-Desktop/.logs/proxy-row.png";
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

await evalJs(`(() => {
  const label = [...document.querySelectorAll("p")].find((e) => e.textContent.trim() === "Proxy");
  if (!label) return false;
  label.scrollIntoView({ block: "center" });
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1200));
const r = await call("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync(out, Buffer.from(r.result.data, "base64"));
console.log("saved " + out);
ws.close();
process.exit(0);
