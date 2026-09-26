import { getWorkerConfig, type WorkerEnv } from "./config";
import {
  applyCorsHeaders,
  createOptionsResponse,
  isAuthorizedApiRequest,
  json,
} from "./http";
import { handleArtist } from "./routes/artist";
import { handleAudioProxy } from "./routes/audio-proxy";
import { handleCollection } from "./routes/collection";
import { handleDeezerSearch } from "./routes/deezer";
import { handleItunesSearch } from "./routes/itunes";
import { handleLicenseProxy } from "./routes/license-proxy";
import { handleLyrics } from "./routes/lyrics";
import { handleSearch } from "./routes/search";
import { handleVideo, resolveJioSaavnPayload } from "./routes/video";

async function routeRequest(
  request: Request,
  env: WorkerEnv,
  config: Awaited<ReturnType<typeof getWorkerConfig>>
): Promise<Response> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/health":
      return json({
        ok: true,
        service: "streamify-cloudflare-api",
        env: env.WORKER_ENV || "unknown",
      });
    case "/video":
      return handleVideo(request, config);
    case "/audio-proxy":
      return handleAudioProxy(request, config);
    case "/license-proxy":
      return handleLicenseProxy(request, config);
    case "/resolve-jiosaavn": {
      // DRM-fallback endpoint: called when Widevine provisioning fails.
      // ?title=X&artist=Y → { audioUrl, title, author, thumbnailUrl } or 404.
      if (request.method !== "GET") {
        return createOptionsResponse(request, config, {
          methods: ["GET"],
          headers: ["Content-Type", "Origin", "Referer", "Authorization"],
        });
      }
      const titleParam = url.searchParams.get("title") || "";
      const artistParam = url.searchParams.get("artist") || "";
      const query = [titleParam, artistParam].filter(Boolean).join(" ").trim();
      if (!query) {
        return json({ error: "Missing title/artist" }, { status: 400 });
      }

      const result = await resolveJioSaavnPayload(
        request,
        config,
        titleParam,
        artistParam || undefined
      );
      if (!result?.audioUrl) {
        return json({ error: "No JioSaavn match found" }, { status: 404 });
      }
      return json(result);
    }
    case "/search":
      return handleSearch(request, config);
    case "/itunes":
      return handleItunesSearch(request, config);
    case "/deezer":
      return handleDeezerSearch(request, config);
    case "/artist":
      return handleArtist(request, config);
    case "/collection":
      return handleCollection(request, config);
    case "/lyrics":
      return handleLyrics(request, config);
    default:
      return json({ error: "Not found" }, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const config = await getWorkerConfig(env);
      const pathname = new URL(request.url).pathname;
      const serverSecret =
        env.STREAMIFY_SERVER_FETCH_SECRET || env.SERVER_FETCH_SECRET || "";
      const isPublicRoute =
        pathname === "/health";

      if (
        !isPublicRoute &&
        !isAuthorizedApiRequest(request, config, serverSecret)
      ) {
        return applyCorsHeaders(
          json(
            {
              error:
                "This API is only available from approved Streamify origins.",
            },
            { status: 403 }
          ),
          request,
          config,
          {
            methods: ["GET", "POST", "HEAD", "OPTIONS"],
            headers: [
              "Content-Type",
              "Origin",
              "Referer",
              "Authorization",
              "Range",
              "x-streamify-server-secret",
            ],
          }
        );
      }

      const response = await routeRequest(request, env, config);
      return applyCorsHeaders(response, request, config, {
        methods: ["GET", "POST", "HEAD", "OPTIONS"],
        headers: [
          "Content-Type",
          "Origin",
          "Referer",
          "Authorization",
          "Range",
          "x-streamify-server-secret",
        ],
        exposeHeaders: [
          "Content-Length",
          "Content-Range",
          "Content-Type",
          "Accept-Ranges",
        ],
      });
    } catch (error) {
      const fallbackConfig = {
        api: {
          allowedOrigins: [],
          proxy: {
            allowedAudioHosts: [],
            allowedLicenseHosts: [],
          },
        },
      };

      return applyCorsHeaders(
        json(
          {
            error: "Unhandled worker error",
            details: error instanceof Error ? error.message : String(error),
          },
          { status: 500 }
        ),
        request,
        fallbackConfig,
        {
          methods: ["GET", "POST", "HEAD", "OPTIONS"],
          headers: [
            "Content-Type",
            "Origin",
            "Referer",
            "Authorization",
            "Range",
            "x-streamify-server-secret",
          ],
        }
      );
    }
  },
};
