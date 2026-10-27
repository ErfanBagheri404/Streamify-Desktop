import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import { requireStreamifyRequest } from "../_lib/request-guard";
import { getProviderEndpoints } from "../../lib/provider-endpoints";

const AUDIO_REQUEST_TIMEOUT_MS = 20000;
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);
const MAX_RETRIES = 3;
// How long to wait for the first body byte before calling the upstream dead.
const FIRST_CHUNK_WAIT_MS = 6000;

function reportDebugEvent(
  _runId: string,
  _hypothesisId: string,
  _location: string,
  _msg: string,
  _data: Record<string, unknown>,
) {
  // Debug event reporting disabled. Kept as a no-op so call sites stay intact.
}

interface ProxiedAudioResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable | ReadableStream;
  finalUrl: string;
  redirectChain: string[];
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return (
    RETRYABLE_ERROR_CODES.has(code) ||
    /fetch failed|aborted|timeout/i.test(message)
  );
}

function readHeader(
  headers: IncomingHttpHeaders,
  name: keyof IncomingHttpHeaders,
): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function buildProxyAudioUrl(audioUrl: string): string {
  return `/api/audio-proxy?url=${encodeURIComponent(audioUrl)}`;
}

function buildLicenseProxyUrl(licenseUrl: string): string {
  return `/api/license-proxy?url=${encodeURIComponent(licenseUrl)}`;
}

function readInterestingHeaders(headers: IncomingHttpHeaders) {
  return {
    contentType: readHeader(headers, "content-type"),
    contentLength: readHeader(headers, "content-length"),
    contentRange: readHeader(headers, "content-range"),
    cacheControl: readHeader(headers, "cache-control"),
    acceptRanges: readHeader(headers, "accept-ranges"),
    location: readHeader(headers, "location"),
    server: readHeader(headers, "server"),
    via: readHeader(headers, "via"),
  };
}

function isSoundCloudHost(hostname: string): boolean {
  return (
    hostname.includes("soundcloud.com") ||
    hostname.includes("sndcdn.com") ||
    hostname.includes("soundcloud.cloud")
  );
}

function headersToIncomingHttpHeaders(
  headers: Headers | { forEach(cb: (value: string, key: string) => void): void },
): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  headers.forEach((value: string, key: string) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

// Tries the media proxy the desktop app handed over (STREAMIFY_MEDIA_PROXY).
// Returns null when the proxy is unusable so the caller can fall back to a
// direct fetch. Uses its own abort controller: this runs before any other
// attempt, and the whole point is to survive a network that blackholes the CDN.
async function requestAudioStreamViaProxy(
  audioUrl: string,
  headers: Record<string, string>,
  redirectChain: string[],
): Promise<ProxiedAudioResponse | null> {
  const proxyUrl = process.env.STREAMIFY_MEDIA_PROXY;
  if (!proxyUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIO_REQUEST_TIMEOUT_MS);
  try {
    const response = await proxyFetch(audioUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
      dispatcher: mediaProxyAgent(proxyUrl),
    });
    if (!response.body) return null;
    // Error statuses (416 for a range past EOF, 403 for an expired signature)
    // carry no meaningful body but must reach the player unchanged.
    const hasBytes =
      response.status >= 400
        ? true
        : await readFirstChunk(response.body, controller.signal);
    if (!hasBytes) return null;
    const finalUrl = response.url || audioUrl;
    return {
      statusCode: response.status,
      headers: headersToIncomingHttpHeaders(response.headers),
      body: response.body,
      finalUrl,
      redirectChain:
        finalUrl !== audioUrl ? [...redirectChain, finalUrl] : redirectChain,
    };
  } catch (error) {
    console.error(
      "Audio proxy media proxy attempt failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Every host goes through `fetch` so it inherits the proxy-aware dispatcher
// installed in instrumentation.ts. Raw https.request resolved DNS itself and the
// local resolver blackholes saavncdn.com (10.10.34.36), which burned the full
// timeout and returned 502 for every JioSaavn track.
async function requestAudioStream(
  audioUrl: string,
  headers: Record<string, string>,
  retryCount = 0,
  redirectChain: string[] = [],
): Promise<ProxiedAudioResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AUDIO_REQUEST_TIMEOUT_MS,
  );

  try {
    // A DPI-blackholed CDN does not fail cleanly: it answers 206 and then
    // trickles bytes at a few hundred per second (measured ~800 B/s against
    // aac.saavncdn.com), so the track buffers forever instead of erroring.
    // When the app hands over a proxy, media goes through it first.
    if (retryCount === 0 && process.env.STREAMIFY_MEDIA_PROXY) {
      const viaProxy = await requestAudioStreamViaProxy(
        audioUrl,
        headers,
        redirectChain,
      );
      if (viaProxy) return viaProxy;
    }

    const response = await fetch(audioUrl, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.body) {
      throw new Error("Audio proxy received empty upstream body");
    }

    // A blackholed CDN still answers 206/200 with the right headers and then
    // sends no bytes at all (measured: plain http to aac.saavncdn.com from a
    // network that DPI-blocks it). Handing that stream to the player looks
    // like a track that never starts, so peek one chunk and treat an empty
    // first read as a transport failure worth retrying.
    const peeked = await readFirstChunk(response.body, controller.signal);
    if (!peeked) {
      throw Object.assign(
        new Error("Upstream returned headers but no body bytes"),
        { code: "ECONNRESET" },
      );
    }

    const finalUrl = response.url || audioUrl;
    const nextRedirectChain =
      finalUrl !== audioUrl ? [...redirectChain, finalUrl] : redirectChain;

    return {
      statusCode: response.status,
      headers: headersToIncomingHttpHeaders(response.headers),
      body: response.body,
      finalUrl,
      redirectChain: nextRedirectChain,
    };
  } catch (error) {
    if (retryCount < MAX_RETRIES && isRetryableError(error)) {
      const delayMs = 250 * (retryCount + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return requestAudioStream(
        audioUrl,
        headers,
        retryCount + 1,
        redirectChain,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildProxyResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const responseHeaders = new Headers({
    "Accept-Ranges": readHeader(headers, "accept-ranges") || "bytes",
    "Cache-Control": "public, max-age=3600",
    "Content-Type": readHeader(headers, "content-type") || "audio/mp4",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type, Origin, Referer",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Content-Type, Accept-Ranges",
  });

  const contentLength = readHeader(headers, "content-length");
  const contentRange = readHeader(headers, "content-range");

  if (contentLength) responseHeaders.set("Content-Length", contentLength);
  if (contentRange) responseHeaders.set("Content-Range", contentRange);

  return responseHeaders;
}

function summarizeAudioUrl(audioUrl: string) {
  try {
    const parsed = new URL(audioUrl);
    return {
      urlHost: parsed.host,
      urlPath: parsed.pathname,
      itag: parsed.searchParams.get("itag"),
      mime: parsed.searchParams.get("mime"),
      source: parsed.searchParams.get("source"),
      expire: parsed.searchParams.get("expire"),
      hasSignature: parsed.searchParams.has("sig"),
      hasPot: parsed.searchParams.has("pot"),
      queryLength: parsed.search.length,
    };
  } catch {
    return {
      urlHost: null,
      urlPath: null,
      itag: null,
      mime: null,
      source: null,
      expire: null,
      hasSignature: null,
      hasPot: null,
      queryLength: null,
    };
  }
}

function isHlsPlaylistResponse(
  finalUrl: string,
  headers: IncomingHttpHeaders,
): boolean {
  const contentType = readHeader(headers, "content-type") || "";
  return (
    /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) ||
    /\.m3u8(?:$|\?)/i.test(finalUrl)
  );
}

function rewriteHlsAttributeUris(line: string, playlistUrl: string): string {
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
        ? buildLicenseProxyUrl(absoluteUrl)
        : buildProxyAudioUrl(absoluteUrl);
      return `URI="${proxied}"`;
    },
  );
}

function rewriteHlsPlaylist(playlistText: string, playlistUrl: string): string {
  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return rewriteHlsAttributeUris(line, playlistUrl);
      }
      if (/^data:/i.test(trimmed)) return line;
      return buildProxyAudioUrl(new URL(trimmed, playlistUrl).toString());
    })
    .join("\n");
}

// The npm undici copy is used on purpose: Node's builtin fetch is a *different*
// undici build and rejects an agent created by this one. This route only ever
// runs on the Node server, and prepare-standalone.mjs ships undici into the
// packaged app, so a static import is safe here (unlike instrumentation.ts,
// which also loads for the edge runtime).
const mediaAgents = new Map<string, ProxyAgent>();

function mediaProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = mediaAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    mediaAgents.set(proxyUrl, agent);
  }
  return agent;
}

// Reads one chunk to prove the connection is live, then puts the chunk back in
// front of the rest of the stream so callers see the body unmodified.
async function readFirstChunk(
  body: Readable | ReadableStream,
  signal: AbortSignal,
  waitMs = FIRST_CHUNK_WAIT_MS,
): Promise<boolean> {
  const webBody =
    body instanceof Readable
      ? (Readable.toWeb(body) as ReadableStream<Uint8Array>)
      : (body as ReadableStream<Uint8Array>);
  const reader = webBody.getReader();
  let result: ReadableStreamReadResult<Uint8Array>;
  try {
    result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        // A live CDN delivers the first chunk in well under a second; a dead
        // one holds the socket open. Cap the wait so a blackholed host fails
        // fast instead of burning the whole request timeout.
        const timer = setTimeout(
          () =>
            reject(Object.assign(new Error("no body bytes"), { code: "ETIMEDOUT" })),
          waitMs,
        );
        const abort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  if (result.done || !result.value?.byteLength) {
    reader.cancel().catch(() => {});
    return false;
  }
  firstChunkByStream.set(webBody, { chunk: result.value, reader });
  return true;
}

// The peeked chunk plus the reader that already owns the rest of the stream.
// The reader cannot be re-acquired (the stream is locked by design), so it is
// kept here and replayed by the handler.
const firstChunkByStream = new WeakMap<
  ReadableStream<Uint8Array>,
  { chunk: Uint8Array; reader: ReadableStreamDefaultReader<Uint8Array> }
>();

function replayFirstChunk(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const peeked = firstChunkByStream.get(body);
  if (!peeked) return body;
  firstChunkByStream.delete(body);
  const { chunk: first, reader } = peeked;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function readResponseBodyAsText(
  body: Readable | ReadableStream,
): Promise<string> {
  const stream =
    body instanceof Readable ? (Readable.toWeb(body) as ReadableStream) : body;
  return new Response(stream).text();
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Content-Type, Origin, Referer",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function GET(request: NextRequest) {
  const blockedResponse = requireStreamifyRequest(request);
  if (blockedResponse) return blockedResponse;

  const { searchParams } = new URL(request.url);
  const audioUrl = searchParams.get("url");
  const runId = `pre-audio-${Date.now()}`;

  // Reject anything that is not a plain http(s) URL here, not inside fetch:
  // `new URL()` on a malformed value throws (500) and `fetch` on file://
  // answers 502, both of which look like a broken stream to the player.
  let parsedAudioUrl: URL | null = null;
  try {
    parsedAudioUrl = audioUrl ? new URL(audioUrl) : null;
  } catch {
    parsedAudioUrl = null;
  }
  if (audioUrl && (!parsedAudioUrl || !/^https?:$/.test(parsedAudioUrl.protocol))) {
    return new NextResponse("Audio URL must be an absolute http(s) URL", {
      status: 400,
    });
  }

  // #region debug-point H4:audio-proxy-entry
  reportDebugEvent(
    runId,
    "H4",
    "app/api/audio-proxy/route.ts:GET:entry",
    "[DEBUG] /api/audio-proxy request received",
    {
      hasAudioUrl: Boolean(audioUrl),
      audioHost: parsedAudioUrl?.host ?? null,
      hasRange: Boolean(request.headers.get("range")),
      urlSummary: audioUrl ? summarizeAudioUrl(audioUrl) : null,
    },
  );
  // #endregion

  if (!audioUrl) {
    // #region debug-point H4:audio-proxy-missing-url
    reportDebugEvent(
      runId,
      "H4",
      "app/api/audio-proxy/route.ts:GET:missing-url",
      "[DEBUG] /api/audio-proxy missing url",
      {},
    );
    // #endregion
    return new NextResponse("Audio URL is required", { status: 400 });
  }

  try {
    const range = request.headers.get("range");
    const providerEndpoints = await getProviderEndpoints();
    const headerOrigins = providerEndpoints.headers.origins;
    const headerReferers = providerEndpoints.headers.referers;

    // Create headers that mimic a real browser request
    const headers: Record<string, string> = {
      // Essential headers to avoid 403 errors
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "audio/mp4,audio/webm,audio/*;q=0.9,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      DNT: "1",
      "Cache-Control": "no-cache",
    };

    // Set appropriate referer and origin based on the audio URL domain
    try {
      const audioUrlObj = new URL(audioUrl);
      if (audioUrlObj.hostname.includes("saavncdn.com")) {
        // JioSaavn specific headers
        headers.Referer = headerReferers.jiosaavn;
        headers.Origin = headerOrigins.jiosaavn;
      } else if (isSoundCloudHost(audioUrlObj.hostname)) {
        // SoundCloud specific headers
        headers.Referer = headerReferers.soundcloud;
        headers.Origin = headerOrigins.soundcloud;
        headers.Accept =
          "application/vnd.apple.mpegurl,application/x-mpegURL,audio/mp4,audio/*;q=0.9,*/*;q=0.5";
      } else {
        // Default YouTube headers
        headers.Referer = headerReferers.youtube;
        headers.Origin = headerOrigins.youtube;
        headers["Sec-Fetch-Dest"] = "audio";
        headers["Sec-Fetch-Mode"] = "cors";
        headers["Sec-Fetch-Site"] = "cross-site";
      }
    } catch {
      // Fallback to YouTube headers if URL parsing fails
      headers.Referer = headerReferers.youtube;
      headers.Origin = headerOrigins.youtube;
      headers["Sec-Fetch-Dest"] = "audio";
      headers["Sec-Fetch-Mode"] = "cors";
      headers["Sec-Fetch-Site"] = "cross-site";
    }

    if (range) headers.Range = range;

    // #region debug-point H4:audio-proxy-fetch-start
    reportDebugEvent(
      runId,
      "H4",
      "app/api/audio-proxy/route.ts:GET:fetch-start",
      "[DEBUG] audio proxy fetch start",
      {
        audioHost: new URL(audioUrl).host,
        hasRange: Boolean(range),
        upstreamPath: `${new URL(audioUrl).host}${new URL(audioUrl).pathname}`,
        configuredDebugSession: null,
        range: range || null,
        urlSummary: summarizeAudioUrl(audioUrl),
        requestHeaders: {
          accept: headers.Accept || null,
          referer: headers.Referer || null,
          origin: headers.Origin || null,
          secFetchDest: headers["Sec-Fetch-Dest"] || null,
          secFetchMode: headers["Sec-Fetch-Mode"] || null,
          secFetchSite: headers["Sec-Fetch-Site"] || null,
          range: headers.Range || null,
        },
      },
    );
    // #endregion
    const response = await requestAudioStream(audioUrl, headers);

    if (new URL(response.finalUrl).host !== new URL(audioUrl).host) {
      // #region debug-point H4:audio-proxy-redirect
      reportDebugEvent(
        runId,
        "H4",
        "app/api/audio-proxy/route.ts:GET:redirect",
        "[DEBUG] audio proxy redirect followed",
        {
          fromHost: new URL(audioUrl).host,
          toHost: new URL(response.finalUrl).host,
          status: response.statusCode,
          redirectChain: response.redirectChain,
          finalUrlSummary: summarizeAudioUrl(response.finalUrl),
        },
      );
      // #endregion
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      // #region debug-point H4:audio-proxy-fetch-failure
      reportDebugEvent(
        runId,
        "H4",
        "app/api/audio-proxy/route.ts:GET:fetch-failure",
        "[DEBUG] audio proxy fetch failed",
        {
          status: response.statusCode,
          audioHost: new URL(response.finalUrl).host,
          finalUrl: response.finalUrl,
          finalUrlSummary: summarizeAudioUrl(response.finalUrl),
          redirectChain: response.redirectChain,
          headers: readInterestingHeaders(response.headers),
        },
      );
      // #endregion
      console.error(`Audio proxy failed with status: ${response.statusCode}`);
      return new NextResponse(
        `Failed to fetch audio stream: ${response.statusCode}`,
        { status: response.statusCode },
      );
    }

    // A CDN error page arrives with 2xx + text/html. Forwarding it as
    // audio/mp4 makes the player stall with no error at all, so surface the
    // real upstream failure instead. HLS playlists are text too and are
    // handled below, hence the playlist check first.
    const upstreamType = (
      readHeader(response.headers, "content-type") || ""
    ).toLowerCase();
    const looksLikeHtml = upstreamType.includes("text/html");

    const responseHeaders = buildProxyResponseHeaders(response.headers);

    const treatAsHlsPlaylist =
      isHlsPlaylistResponse(response.finalUrl, response.headers) ||
      /\.m3u8(?:$|\?)/i.test(audioUrl);

    if (looksLikeHtml && !treatAsHlsPlaylist) {
      console.error(
        `Audio proxy got an HTML page instead of audio from ${new URL(response.finalUrl).host}`,
      );
      return new NextResponse(
        "Upstream returned an HTML page instead of audio",
        { status: 502 },
      );
    }

    if (treatAsHlsPlaylist) {
      const playlistText = await readResponseBodyAsText(
        response.body instanceof Readable
          ? (Readable.toWeb(response.body) as ReadableStream)
          : replayFirstChunk(response.body as ReadableStream),
      );
      const rewrittenPlaylist = rewriteHlsPlaylist(
        playlistText,
        response.finalUrl,
      );
      responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
      responseHeaders.delete("Content-Length");
      // HLS playlists contain short-lived signed URLs (Policy/Signature
      // tokens with an `expires=` timestamp). Caching them for an hour
      // would mean Shaka keeps using an expired manifest and would keep
      // hitting a stale #EXT-X-KEY URI. Force a re-fetch every time.
      responseHeaders.set("Cache-Control", "no-store, max-age=0");
      responseHeaders.set("Pragma", "no-cache");

      // Surface the rewritten license URIs so we can see in the proxy
      // logs that #EXT-X-KEY is being routed through /api/license-proxy.
      const rewrittenKeyLines = rewrittenPlaylist
        .split(/\r?\n/)
        .filter((line) => /^#EXT-X-KEY/i.test(line.trim()));
      console.log(
        `[audio-proxy] ${runId} HLS rewrite`,
        JSON.stringify({
          audioHost: new URL(response.finalUrl).host,
          finalUrl: response.finalUrl,
          lineCount: playlistText.split(/\r?\n/).length,
          extXKeyLineCount: rewrittenKeyLines.length,
          extXKeySample: rewrittenKeyLines[0] || null,
        }),
      );

      responseHeaders.set("X-Streamify-RunId", runId);
      responseHeaders.set("X-Streamify-HlsRewrite", "1");
      responseHeaders.set(
        "X-Streamify-HasExtXKey",
        String(rewrittenKeyLines.length),
      );

      reportDebugEvent(
        runId,
        "H4",
        "app/api/audio-proxy/route.ts:GET:hls-playlist-rewritten",
        "[DEBUG] audio proxy HLS playlist rewritten",
        {
          audioHost: new URL(response.finalUrl).host,
          finalUrl: response.finalUrl,
          redirectChain: response.redirectChain,
          lineCount: playlistText.split(/\r?\n/).length,
          extXKeyLineCount: rewrittenKeyLines.length,
          extXKeySample: rewrittenKeyLines[0] || null,
        },
      );

      return new NextResponse(rewrittenPlaylist, {
        status: response.statusCode,
        headers: responseHeaders,
      });
    }

    // #region debug-point H4:audio-proxy-success
    reportDebugEvent(
      runId,
      "H4",
      "app/api/audio-proxy/route.ts:GET:success",
      "[DEBUG] audio proxy fetch succeeded",
      {
        status: response.statusCode,
        contentType: readHeader(response.headers, "content-type"),
        audioHost: new URL(response.finalUrl).host,
        finalUrl: response.finalUrl,
        finalUrlSummary: summarizeAudioUrl(response.finalUrl),
        redirectChain: response.redirectChain,
        contentRange: readHeader(response.headers, "content-range"),
        contentLength: readHeader(response.headers, "content-length"),
      },
    );
    // #endregion
    return new NextResponse(
      response.body instanceof Readable
        ? (Readable.toWeb(response.body) as ReadableStream)
        : replayFirstChunk(response.body as ReadableStream),
      {
        status: response.statusCode,
        headers: responseHeaders,
      },
    );
  } catch (error) {
    // #region debug-point H4:audio-proxy-exception
    reportDebugEvent(
      runId,
      "H4",
      "app/api/audio-proxy/route.ts:GET:exception",
      "[DEBUG] audio proxy exception",
      {
        error: error instanceof Error ? error.message : String(error),
        audioHost: audioUrl ? new URL(audioUrl).host : null,
        urlSummary: audioUrl ? summarizeAudioUrl(audioUrl) : null,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : null,
      },
    );
    // #endregion
    console.error(
      "Audio proxy error:",
      error instanceof Error ? `${error.name}: ${error.message} (code=${(error as { code?: string }).code ?? "-"})` : String(error),
    );
    return new NextResponse("Failed to proxy audio stream", { status: 502 });
  }
}
