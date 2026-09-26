// Electron-embeddable API server: same worker.fetch() pipeline as streamifyapi,
// wrapped in a startable/stoppable function on 127.0.0.1 with a dynamic free port.
import http from "node:http";
import { Readable } from "node:stream";
import worker from "./src/index.js";
// Inline runtime config snapshot (fetched from instances.streamify.workers.dev,
// Origin: http://localhost:3000). Bundled by esbuild; kills the cold-boot delay
// from fetching remote config. Remote deployments can still refresh via CONFIG_URL.
import runtimeConfig from "./runtime-config.json";

export type RunningApiServer = { port: number; close: () => Promise<void> };

function getEnv() {
  return {
    CONFIG_URL: process.env.CONFIG_URL,
    RUNTIME_CONFIG_JSON: process.env.RUNTIME_CONFIG_JSON || JSON.stringify(runtimeConfig),
    ALLOWED_ORIGINS:
      process.env.ALLOWED_ORIGINS ||
      "http://localhost:3000,http://127.0.0.1:3000",
    WORKER_ENV: process.env.WORKER_ENV || "production",
    SERVER_FETCH_SECRET: process.env.SERVER_FETCH_SECRET,
    STREAMIFY_SERVER_FETCH_SECRET: process.env.STREAMIFY_SERVER_FETCH_SECRET,
  };
}

function firstHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function buildExternalUrl(req: http.IncomingMessage, port: number): string {
  const proto =
    firstHeaderValue(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim() ||
    "http";
  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ||
    req.headers.host ||
    `127.0.0.1:${port}`;
  return `${proto}://${host}${req.url || "/"}`;
}

function toHeaders(headersObject: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headersObject)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return headers;
}

export async function startApiServer(
  preferredPort = Number(process.env.STREAMIFY_API_PORT || 7861)
): Promise<RunningApiServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const hasBody = !["GET", "HEAD"].includes(method);
      const requestInit: RequestInit & { duplex?: "half" } = {
        method,
        headers: toHeaders(req.headers),
      };

      if (hasBody) {
        requestInit.body = Readable.toWeb(req) as ReadableStream;
        requestInit.duplex = "half";
      }

      const response = await worker.fetch(
        new Request(buildExternalUrl(req, preferredPort), requestInit),
        getEnv()
      );

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!response.body) {
        res.end();
        return;
      }

      Readable.fromWeb(response.body as any).pipe(res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Unhandled server error",
          details: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as { port: number }).port;
  console.log(`[api] streamifyapi in-process on http://127.0.0.1:${port}`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// Standalone run: `node dist/api-server.mjs`. Bundlers rewrite argv paths,
// so we compare normalized paths; on miss we still run when STREAMIFY_API_STANDALONE=1.
const invoked = (process.argv[1] || "").replace(/\\/g, "/");
const here = import.meta.url.replace(/^file:\/\/+/, "").replace(/\\/g, "/");
const isDirect = invoked.length > 0 && (here.startsWith(invoked) || invoked.startsWith(here));

if (isDirect || process.env.STREAMIFY_API_STANDALONE === "1") {
  startApiServer().catch((err) => {
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
}
