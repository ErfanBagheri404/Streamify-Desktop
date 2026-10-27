import type { WorkerConfig } from "../config";
import { buildWorkerUrl, createOptionsResponse, json } from "../http";

const AUDIO_REQUEST_TIMEOUT_MS = 20000;
// How long to wait for the first body byte before calling the upstream dead.
const FIRST_CHUNK_WAIT_MS = 6000;

// A DPI-blackholed CDN answers 206 and then trickles a few hundred bytes per
// second (measured against aac.saavncdn.com), so a track buffers forever
// instead of erroring. When the desktop app hands over a proxy, media goes
// through it first — even with the app-level proxy setting turned off.
const mediaProxyUrl =
  process.env.STREAMIFY_MEDIA_PROXY || process.env.HTTPS_PROXY || "";

let mediaAgent: unknown = null;
let mediaAgentUrl = "";
async function getMediaAgent(proxyUrl: string): Promise<unknown> {
  if (mediaAgent && mediaAgentUrl === proxyUrl) return mediaAgent;
  const undici = await import("undici");
  mediaAgent = new undici.ProxyAgent(proxyUrl);
  mediaAgentUrl = proxyUrl;
  return mediaAgent;
}

// Proves the connection is live by reading one chunk, and returns it so the
// caller can serve it before the rest of the stream.
async function peekFirstChunk(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  waitMs = FIRST_CHUNK_WAIT_MS
): Promise<ReadableStream<Uint8Array> | null> {
  const reader = body.getReader();
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(Object.assign(new Error("no body bytes"), { code: "ETIMEDOUT" })),
          waitMs
        );
        const abort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    if (result.done || !result.value?.byteLength) {
      reader.cancel().catch(() => {});
      return null;
    }
    // Re-wrap: the peeked chunk first, then whatever the reader still holds.
    const replayed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(result.value as Uint8Array);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else if (next.value) controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return replayed;
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
}

function matchesAllowedHost(hostname: string, allowedHost: string): boolean {
  const lowerHostname = hostname.toLowerCase();
  const lowerAllowedHost = allowedHost.toLowerCase();
  return (
    lowerHostname === lowerAllowedHost ||
    lowerHostname.endsWith(`.${lowerAllowedHost}`)
  );
}

function isAllowedAudioHost(hostname: string, config: WorkerConfig): boolean {
  const configuredHosts = [
    ...config.instances.invidious,
    ...config.instances.piped,
  ]
    .map((value) => {
      try {
        return new URL(value).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const allowedHosts = [
    ...config.api.proxy.allowedAudioHosts,
    ...configuredHosts,
  ];

  return allowedHosts.some((allowedHost) =>
    matchesAllowedHost(hostname, allowedHost)
  );
}

function isSoundCloudHost(hostname: string): boolean {
  return (
    hostname.includes("soundcloud.com") ||
    hostname.includes("sndcdn.com") ||
    hostname.includes("soundcloud.cloud")
  );
}

function isHlsPlaylistResponse(finalUrl: string, headers: Headers): boolean {
  const contentType = headers.get("content-type") || "";
  return (
    /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) ||
    /\.m3u8(?:$|\?)/i.test(finalUrl)
  );
}

function buildProxyHeaders(
  request: Request,
  audioUrl: URL,
  config: WorkerConfig
): Headers {
  const headers = new Headers({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "audio/mp4,audio/webm,audio/*;q=0.9,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    DNT: "1",
    "Cache-Control": "no-cache",
  });

  const range = request.headers.get("range");
  if (range) {
    headers.set("Range", range);
  }

  if (audioUrl.hostname.includes("saavncdn.com")) {
    headers.set("Referer", config.headers.referers.jiosaavn);
    headers.set("Origin", config.headers.origins.jiosaavn);
  } else if (isSoundCloudHost(audioUrl.hostname)) {
    headers.set("Referer", config.headers.referers.soundcloud);
    headers.set("Origin", config.headers.origins.soundcloud);
    headers.set(
      "Accept",
      "application/vnd.apple.mpegurl,application/x-mpegURL,audio/mp4,audio/*;q=0.9,*/*;q=0.5"
    );
  } else {
    headers.set("Referer", config.headers.referers.youtube);
    headers.set("Origin", config.headers.origins.youtube);
    headers.set("Sec-Fetch-Dest", "audio");
    headers.set("Sec-Fetch-Mode", "cors");
    headers.set("Sec-Fetch-Site", "cross-site");
  }

  return headers;
}

function buildResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    "Cache-Control": "public, max-age=3600",
    "Content-Type": upstream.headers.get("content-type") || "audio/mp4",
  });

  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");

  if (contentLength) headers.set("Content-Length", contentLength);
  if (contentRange) headers.set("Content-Range", contentRange);

  return headers;
}

function rewriteHlsAttributeUris(
  line: string,
  playlistUrl: string,
  request: Request
): string {
  const isKeyLine = /^#EXT-X-KEY(?::[^,\s]+)?\b/i.test(line.trim());

  return line.replace(
    /URI=(?:"([^"]+)"|'([^']+)'|([^",\s]+))/g,
    (_match, doubleQuoted, singleQuoted, bare) => {
      const uri =
        typeof doubleQuoted === "string" && doubleQuoted
          ? doubleQuoted
          : typeof singleQuoted === "string" && singleQuoted
          ? singleQuoted
          : typeof bare === "string" && bare
          ? bare
          : "";

      if (!uri || /^data:/i.test(uri)) return `URI="${uri}"`;
      const absoluteUrl = new URL(uri, playlistUrl).toString();
      const proxied = isKeyLine
        ? buildWorkerUrl(request, "/license-proxy", { url: absoluteUrl })
        : buildWorkerUrl(request, "/audio-proxy", { url: absoluteUrl });
      return `URI="${proxied}"`;
    }
  );
}

function rewriteHlsPlaylist(
  playlistText: string,
  playlistUrl: string,
  request: Request
): string {
  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return rewriteHlsAttributeUris(line, playlistUrl, request);
      }
      if (/^data:/i.test(trimmed)) return line;
      return buildWorkerUrl(request, "/audio-proxy", {
        url: new URL(trimmed, playlistUrl).toString(),
      });
    })
    .join("\n");
}

// Maps an upstream Response to the stream that replays its peeked first
// chunk. WeakMap so nothing outlives the request.
const peekedBodies = new WeakMap<Response, ReadableStream<Uint8Array>>();

// Proxied first (when the app supplied one) because a blackholed CDN does not
// fail loudly — it answers 206 and trickles. Falls back to a direct fetch.
async function fetchUpstreamAudio(
  target: string,
  headers: Headers,
  signal: AbortSignal
): Promise<Response> {
  if (mediaProxyUrl) {
    try {
      const undici = await import("undici");
      const viaProxy = await undici.fetch(target, {
        method: "GET",
        headers: headers as unknown as Record<string, string>,
        redirect: "follow",
        signal,
        dispatcher: (await getMediaAgent(mediaProxyUrl)) as never,
      });
      if (viaProxy.ok) {
        const stream = viaProxy.body as ReadableStream<Uint8Array> | null;
        if (!stream) return viaProxy as unknown as Response;
        const peeked = await peekFirstChunk(stream, signal);
        if (peeked) {
          peekedBodies.set(viaProxy as unknown as Response, peeked);
          return viaProxy as unknown as Response;
        }
      }
      // Non-2xx from the proxy path is a real answer (416 past EOF, 403
      // expired signature): let the caller surface it instead of retrying.
      if (viaProxy.status >= 400 && viaProxy.status < 500) {
        return viaProxy as unknown as Response;
      }
    } catch (error) {
      console.error(
        "[audio-proxy] media proxy attempt failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const direct = await fetch(target, {
    method: "GET",
    headers,
    redirect: "follow",
    signal,
  });
  if (direct.ok && direct.body) {
    const peeked = await peekFirstChunk(direct.body, signal);
    if (peeked) {
      peekedBodies.set(direct, peeked);
      return direct;
    }
  }
  return direct;
}

export async function handleAudioProxy(
  request: Request,
  config: WorkerConfig
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return createOptionsResponse(request, config, {
      methods: ["GET", "HEAD", "OPTIONS"],
      headers: ["Range", "Content-Type", "Origin", "Referer"],
      exposeHeaders: [
        "Content-Length",
        "Content-Range",
        "Content-Type",
        "Accept-Ranges",
      ],
    });
  }

  const url = new URL(request.url);
  const audioUrl = url.searchParams.get("url");
  if (!audioUrl) {
    return json({ error: "Audio URL is required" }, { status: 400 });
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(audioUrl);
  } catch {
    return json({ error: "Invalid audio URL" }, { status: 400 });
  }

  if (!isAllowedAudioHost(upstreamUrl.hostname, config)) {
    return json({ error: "Disallowed audio host" }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetchUpstreamAudio(
      upstreamUrl.toString(),
      buildProxyHeaders(request, upstreamUrl, config),
      controller.signal
    );

    if (!upstream.ok) {
      return new Response(`Failed to fetch audio stream: ${upstream.status}`, {
        status: upstream.status,
      });
    }

    const responseHeaders = buildResponseHeaders(upstream);
    const finalUrl = upstream.url || upstreamUrl.toString();
    const treatAsHlsPlaylist =
      isHlsPlaylistResponse(finalUrl, upstream.headers) ||
      /\.m3u8(?:$|\?)/i.test(upstreamUrl.toString());

    if (treatAsHlsPlaylist) {
      // fetchUpstreamAudio already pulled a chunk off the body to prove the
      // connection was live, so upstream.text() throws "Body has already been
      // read". Read through the replaying stream instead.
      const playlistText = await new Response(
        peekedBodies.get(upstream) ?? upstream.body
      ).text();
      const rewrittenPlaylist = rewriteHlsPlaylist(
        playlistText,
        finalUrl,
        request
      );
      responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
      responseHeaders.set("Cache-Control", "no-store, max-age=0");
      responseHeaders.set("Pragma", "no-cache");
      responseHeaders.delete("Content-Length");
      return new Response(rewrittenPlaylist, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    // An HTML error page with a 2xx is not audio; forwarding it makes the
    // player stall without ever raising an error.
    const upstreamType = (upstream.headers.get("content-type") || "").toLowerCase();
    if (upstreamType.includes("text/html")) {
      return json(
        { error: "Upstream returned an HTML page instead of audio" },
        { status: 502 }
      );
    }

    // Replay the chunk peeked by fetchUpstreamAudio so no bytes are lost.
    return new Response(peekedBodies.get(upstream) ?? upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return json(
      {
        error: "Failed to proxy audio stream",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
