# Streamify Desktop

The Streamify web player, packaged as a native Windows desktop app — with the Streamify API running **in-process** so there is no hosted-API round trip, no cold start, and no added delay between the UI and the backend.

## What this is

- **Exact app parity** — `app/` is a file-for-file copy of the Streamify web client (Next.js 16, React 19, Tailwind v4). Every page, player, library, settings, auth, session, and lyrics feature is present.
- **In-process API** — the Streamify backend (`api/`) is bundled with esbuild and loaded directly into the Electron main process via `startApiServer()`. The renderer talks to `http://127.0.0.1:7861` (never exposed externally). No serverless functions, no remote config fetch, no extra network hop.
- **Desktop integration** — native menu bar (File / View / Playback / Help), system tray, media keys (play/pause/next/previous via `globalShortcut` + `mediaSession`), single-instance lock, window bounds persistence, theme sync with the app's own light/dark setting, and external links opened in the system browser.
- **Packaged** — NSIS installer + portable exe via electron-builder. The Next app ships as a standalone build (`output: "standalone"`), so the packaged app needs no system Node.

## Architecture

```
Electron main process
├── In-process Streamify API  (dist/api-server.mjs, port 7861)
│   └── startApiServer() — all routes: /video /audio-proxy /license-proxy
│       /search /artist /collection /lyrics /config /health
└── Next.js child process (port 3000)
    ├── dev:   next dev --webpack
    └── prod:  .next/standalone/server.js  (no node_modules needed)
```

The renderer fetches backend routes through `buildBackendRouteUrl()` with a fallback chain: local in-process API → `helloify-api.hf.space` → `api.streamify.workers.dev`. On this network the local API is the only one that works for most sources.

## Build

```bash
npm install
npm run build          # esbuild API bundle + Next production build + standalone copy
npm run dist           # NSIS installer + portable exe -> release/
npm run dist:dir       # unpacked build only (fast iteration)
```

Artifacts (gitignored): `release/`, `release.old/`, `.logs/`, `dist/`, `app/.next/`, `node_modules/`.

## Dev

```bash
npm run dev            # API + Next + Electron concurrently (needs ports 7861/3000 free)
```

Set `STREAMIFY_DEBUG_PORT=9555` to expose Chrome DevTools Protocol on the Electron renderer — the `scripts/*.mjs` probes (hit-test, route-probe, verify-row-play, ui-gallery) drive the UI over CDP for verification.

## Verification

End-to-end playback was verified in the packaged app: search → open a JioSaavn track → play → `<audio>` element reaches `readyState 4`, `paused=false`, time advancing (4.37s → 25.41s of 248.5s), audio fetched through the in-process `/audio-proxy` route.

## Known limitations

- **YouTube** is currently unreachable from this network (Invidious/Piped instances timeout or 503; the hosted fallback APIs also fail — YouTube is blocking anonymous watch access). The app still renders and plays other sources.
- **SoundCloud** client-id scraping requires `soundcloud.com` / `api-v2.soundcloud.com`, which are blocked here. The media CDN (`sndcdn.com`) is reachable, so audio files themselves can stream once a client id is available.
- The app is a desktop wrapper around the existing web client; upstream bugs (e.g. the artist-page hydration mismatch) are inherited, not introduced.
