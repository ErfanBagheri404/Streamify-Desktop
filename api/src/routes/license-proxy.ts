import type { WorkerConfig } from "../config";
import { createOptionsResponse, json } from "../http";

const LICENSE_PROXY_TIMEOUT_MS = 15000;

// SoundCloud license tokens are single-use. Shaka retries the license request
// when the first response is slow or when it reconfigures; the second POST with
// the same token gets 403. Cache the successful license per token so retries
// get the same bytes instead of a 403.
const licenseCache = new Map<string, { body: ArrayBuffer; contentType: string; expires: number }>();
const LICENSE_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedLicense(token: string) {
  const hit = licenseCache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.expires) { licenseCache.delete(token); return null; }
  return hit;
}

function setCachedLicense(token: string, body: ArrayBuffer, contentType: string) {
  licenseCache.set(token, { body, contentType, expires: Date.now() + LICENSE_CACHE_TTL_MS });
  if (licenseCache.size > 64) {
    const oldest = licenseCache.keys().next().value;
    if (oldest) licenseCache.delete(oldest);
  }
}

// Widevine msg_type (first protobuf varint) distinguishes the CDM's
// server-certificate request from its license request. Both go to the same URL
// but must never share a cache slot: a LICENSE response replayed onto a
// certificate request makes the CDM reject the update (Shaka error 6008).
function widevineMessageType(body: ArrayBuffer): number | null {
  const bytes = new Uint8Array(body);
  if (bytes.length < 2) return null;
  // field 1, varint wire type
  if (bytes[0] !== 0x08) return null;
  return bytes[1] & 0x7f;
}

function extractLicenseToken(licenseUrl: string): string | null {
  try {
    return new URL(licenseUrl).searchParams.get("license_token");
  } catch {
    return null;
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

function isAllowedLicenseUrl(value: string, config: WorkerConfig): boolean {
  try {
    const parsed = new URL(value);
    return config.api.proxy.allowedLicenseHosts.some((host) =>
      matchesAllowedHost(parsed.hostname, host)
    );
  } catch {
    return false;
  }
}

export async function handleLicenseProxy(
  request: Request,
  config: WorkerConfig
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return createOptionsResponse(request, config, {
      methods: ["GET", "POST", "OPTIONS"],
      headers: ["Content-Type", "Origin", "Referer", "Authorization"],
    });
  }

  const url = new URL(request.url);
  const licenseUrl = url.searchParams.get("url");

  if (!licenseUrl) {
    return json(
      {
        ok: true,
        message: "License proxy is reachable",
        expects: "POST ?url=<soundcloud-widevine-license-url> with binary body",
        allowedHosts: config.api.proxy.allowedLicenseHosts,
      },
      { status: 200 }
    );
  }

  if (!isAllowedLicenseUrl(licenseUrl, config)) {
    return json({ error: "Disallowed license URL host" }, { status: 400 });
  }

  const licenseToken = extractLicenseToken(licenseUrl);
  const requestMsgType =
    request.method === "POST" ? widevineMessageType(await request.clone().arrayBuffer()) : null;
  const cacheKey = licenseToken && requestMsgType !== null ? `${licenseToken}:${requestMsgType}` : null;
  if (cacheKey) {
    const cached = getCachedLicense(cacheKey);
    if (cached) {
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (cached.contentType) headers.set("Content-Type", cached.contentType);
      return new Response(cached.body, { status: 200, headers });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LICENSE_PROXY_TIMEOUT_MS);

  try {
    if (request.method === "GET" || request.method === "HEAD") {
      const upstream = await fetch(licenseUrl, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
      });

      return json(
        {
          ok: upstream.ok,
          status: upstream.status,
          contentType: upstream.headers.get("content-type"),
          contentLength: upstream.headers.get("content-length"),
          accessControlAllowOrigin: upstream.headers.get(
            "access-control-allow-origin"
          ),
        },
        { status: upstream.ok ? 200 : upstream.status }
      );
    }

    const body = await request.arrayBuffer();
    if (!body || body.byteLength === 0 || body.byteLength > 2 * 1024 * 1024) {
      return json(
        { error: "Empty or oversized license request body" },
        { status: 400 }
      );
    }

    const headers = new Headers({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type":
        request.headers.get("content-type") || "application/octet-stream",
      // Mimic the SoundCloud widget iframe: the license endpoint validates
      // the token against this origin. soundcloud.com gets 401/403.
      Referer: "https://w.soundcloud.com/player/",
      Origin: "https://w.soundcloud.com",
    });

    const authorization = request.headers.get("authorization");
    if (authorization) {
      headers.set("Authorization", authorization);
    }

    const upstream = await fetch(licenseUrl, {
      method: "POST",
      headers,
      body,
      redirect: "follow",
      signal: controller.signal,
    });

    console.log(`[license-proxy] upstream status=${upstream.status} ct=${upstream.headers.get("content-type")}`);

    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
    });
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      responseHeaders.set("Content-Type", contentType);
    }

    if (licenseToken && upstream.ok) {
      const buf = await upstream.arrayBuffer();
      setCachedLicense(licenseToken, buf, contentType || "application/octet-stream");
      return new Response(buf, { status: upstream.status, headers: responseHeaders });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return json(
      {
        error: "license proxy fetch failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
