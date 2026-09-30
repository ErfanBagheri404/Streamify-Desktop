// Evaluates an expression against the running app over CDP.
// Usage: node scripts/cdp-eval.mjs <expression-or-@file> [port]
import { readFileSync } from "node:fs";
const port = Number(process.argv[3] || 9444);
let expression = process.argv[2];
if (!expression) {
  console.error("usage: node scripts/cdp-eval.mjs <expression|@file> [port]");
  process.exit(2);
}
if (expression.startsWith("@")) expression = readFileSync(expression.slice(1), "utf8");
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = tabs.find((t) => t.type === "page");
if (!page) {
  console.error("no page target on port " + port);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const result = await new Promise((res) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) {
      res(m);
      ws.close();
    }
  };
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
});
const r = result.result?.result;
console.log(r?.value ?? JSON.stringify(result.result ?? result.error));
process.exit(0);
