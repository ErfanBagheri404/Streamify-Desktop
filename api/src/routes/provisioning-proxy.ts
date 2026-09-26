import type { WorkerConfig } from "../config";
import { createOptionsResponse, json } from "../http";

const PROVISIONING_TIMEOUT_MS = 15000;

function isAllowedProvisioningHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "proxy.gvt1.com" ||
    lower === "www.googleapis.com" ||
    lower.endsWith(".gvt1.com") ||
    lower.endsWith(".googleapis.com") ||
    lower.endsWith(".widevine.com")
  );
}

// Transient debug
const DBG = true;

export async function handleProvisioningProxy(
  request: Request,
  _config: WorkerConfig,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return createOptionsResponse(request, _config, {
      methods: ["POST", "OPTIONS"],
      headers: ["Content-Type", "Origin", "Referer"],
    });
  }

  const url = new URL(request.url);
  const overrideUrl = url.searchParams.get("url");

  if (request.method !== "POST") {
    return json(
      { ok: true, message: "Provisioning proxy is reachable", url: overrideUrl || "none" },
      { status: 200 },
    );
  }

  // Widevine provisioning: the request.defaultUrl from ExoPlayer is used if provided.
  // Some CDN/device combos return an empty defaultUrl — then we must not override with a default
  // that uses the wrong provider= param (causes 400 from Google).
  let provisioningUrl = overrideUrl || "https://proxy.gvt1.com/provisioning?provider=widevine_test";
  if (overrideUrl) {
    try {
      const parsed = new URL(overrideUrl);
      if (!isAllowedProvisioningHost(parsed.hostname)) {
        return json({ error: "Disallowed provisioning host" }, { status: 400 });
      }
      provisioningUrl = overrideUrl;
    } catch {
      return json({ error: "Invalid provisioning URL" }, { status: 400 });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVISIONING_TIMEOUT_MS);

  try {
    const body = await request.arrayBuffer();

    const upstream = await fetch(provisioningUrl, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") || "application/octet-stream",
        "User-Agent": request.headers.get("user-agent") || "ExoPlayer/1.8.0 (Linux;Android)",
      },
      body,
      redirect: "follow",
      signal: controller.signal,
    });

    const bytes = await upstream.arrayBuffer();
    if (DBG) {
      console.log(
        "[provisioning-proxy]",
        "provisioningUrl=",
        provisioningUrl,
        "origin=",
        request.headers.get("origin"),
        "upstream=",
        upstream.status,
        String(upstream.headers.get("content-type")),
        "bodyLen=",
        bytes.byteLength,
      );
    }
    return new Response(bytes, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (DBG) console.error("[provisioning-proxy] fetch failed:", String(error));
    return json(
      {
        error: "provisioning proxy fetch failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
