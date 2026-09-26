// Captures the FULL first hydration/exception message for a route in the running
// desktop app (verify-ui.mjs truncates to keep the report small).
//   node scripts/capture-error.mjs /artist/channel/FGBhQbmPwH8
import http from "node:http";

const route = process.argv[2] || "/";
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
const seen = [];
ws.onmessage = (evt) => {
  const m = JSON.parse(String(evt.data));
  if (m.method === "Runtime.exceptionThrown") {
    seen.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

send("Runtime.enable");
send("Page.enable");
setTimeout(() => send("Page.navigate", { url: `http://localhost:3000${route}` }), 500);
setTimeout(() => {
  console.log(JSON.stringify({ route, exceptions: seen.slice(0, 3) }, null, 2));
  ws.close();
  process.exit(0);
}, 12000);
