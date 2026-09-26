import http from "node:http";
import { Readable } from "node:stream";
import worker from "./src/index.js";

const port = Number(process.env.PORT || 7860);

function getEnv() {
  return {
    CONFIG_URL: process.env.CONFIG_URL,
    RUNTIME_CONFIG_JSON: process.env.RUNTIME_CONFIG_JSON,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
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

function buildExternalUrl(req: http.IncomingMessage): string {
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
      new Request(buildExternalUrl(req), requestInit),
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

server.listen(port, "0.0.0.0", () => {
  console.log(`streamifyapi listening on http://0.0.0.0:${port}`);
});
