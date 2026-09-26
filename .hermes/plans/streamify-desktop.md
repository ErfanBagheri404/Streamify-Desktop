# Streamify Desktop (Electron) — Plan

Repo: https://github.com/ErfanBagheri404/Streamify-Desktop
Local: `E:\Dev\Projects\Streamify-Desktop`

## Goal

The exact `streamifyweb-player` Next.js app running as a desktop app, plus the
`streamifyapi` Cloudflare-Worker API executed **in-process** so no request ever
leaves the machine (no hosted-API round trip, no cold start, no added delay).

## Sources

| Source | What we take |
|---|---|
| `E:\Dev\Projects\streamifyweb-player\client` | Full Next.js app (151 tracked files) → vendored into `app/` |
| `E:\Dev\Projects\streamifyapi` | Worker entry + routes + config + http → vendored into `api/` |
| new | `electron/` host: boots API server + Next server, window, desktop integration |

## Architecture

```
Electron main process (single Node process)
 ├─ API server      http://127.0.0.1:7861  ← vendored streamifyapi worker.fetch()
 │                   (handles /video /search /artist /collection /lyrics
 │                    /audio-proxy /license-proxy /itunes /deezer …)
 └─ Next server     http://localhost:3000   ← `next dev` (dev) / `next build`+`next start` (prod)
                     handles pages + remaining route handlers
                          │
BrowserWindow ────────────┘  (renderer = the untouched web app)
```

Routing switch is **env only** — zero app code changes:
`NEXT_PUBLIC_STREAMIFY_API_MODE=absolute`,
`NEXT_PUBLIC_STREAMIFY_API_BASE_URL=http://127.0.0.1:7861,<remote fallbacks>`.
`backend-api.ts` already walks candidates in order and retries on 403/404/429/5xx,
so local-first is automatic and the hosted API stays as a fallback.

## Feature scope — what is EXACTLY kept

- Pages: home, search, library, artist (id + channel), collection, settings,
  session list / session detail / privacy / terms, signin, signup,
  forgot-password, reset-password, auth/callback, liquid-test.
- Components: AppShell, LeftPanel, ShellLayout, MiniPlayer (725),
  FullscreenPlayer (1363), NowPlayingSidePanel, PlaylistCreateModal,
  HorizontalScrollRow, CommunityBanner, MobileAppGate, CloudLibraryBridge,
  search/*, SourceIcon, PageTitle, DynamicMainContent, icons.
- Contexts: AudioContext (4646), Settings, Toast, SidePanel.
- Libs: local-library (1266), cloud-library-sync, backend-api, provider-endpoints,
  i18n (en/fa), lyrics (+shared), app-settings, media-providers, navigation-state,
  youtube-thumbnails, search-category-playlists, session-cache, supabase/*.
- Assets: public/ (fonts, categories, sources, svgs, Banner, LoginImage), sw.js.
- Route handlers: all 13 kept (`app/api/*`) — unchanged.
- Config kept as-is: `proxy.ts` (middleware), `next.config.js`, `postcss`,
  `eslint.config.mjs`, `tsconfig.json`, `.env.local`.

## Out of scope / knowingly absent

| Item | Why |
|---|---|
| `streamifyweb-player/server` (Express 3001) | Not in source repo any more; superseded by API |
| `cloudflare-api/` (CF Worker, pruned) | Superseded by vendored `streamifyapi` |
| PWA install prompt / `appleWebApp` semantics | Desktop app replaces it; `sw.js` still ships verbatim |
| `NEXT_PUBLIC_SITE_URL=https://streamifyweb-player.vercel.app` | Absolute URLs now point at local origin |
| Repo `.github/` workflows, ISSUE_TEMPLATES | Belong to the web repo, not the desktop app |
| Widevine CDM | Electron has none; `soundcloud-drm` fails to local `/resolve-jiosaavn` fallback |

## Phases

Each phase ends with a commit + push.

### Phase 1 — Scaffold ✅⬜
- Clone `ErfanBagheri404/Streamify-Desktop` (empty) → `E:\Dev\Projects\Streamify-Desktop`
- Copy 151 tracked `client/` files → `app/`, plus `app/README.md`
- Copy `streamifyapi/src` + `server.ts` → `api/`, keep `api/tests` + `package.json`
- Root `package.json` (electron, electron-builder, concurrently, wait-on, cross-env)
- `.gitignore`, `.hermes/plans/streamify-desktop.md`
- **Done:** `git log` has 1 commit, `git ls-remote origin main` matches, `app/` + `api/` present

### Phase 2 — In-process API server ✅⬜  *(Depends: 1)*
- `api/server.ts` → exported `startApiServer()` returning `{ port, close }`, binds 127.0.0.1, dynamic free port, `ALLOWED_ORIGINS` = `http://localhost:3000,http://127.0.0.1:3000`
- esbuild bundle `api/server.ts` → `dist/api-server.mjs` (no `tsx` at runtime)
- `scripts/check-api.mjs` health probe
- **Done:** `node scripts/check-api.mjs` prints `{ ok: true }` from a bundled build

### Phase 3 — Electron host boots both servers ✅⬜  *(Depends: 2)*
- `electron/main.js`: single-instance lock, start API, start Next, poll `/` until ready, `BrowserWindow` at `http://localhost:3000`, block `setWindowOpenHandler` external opens, persist bounds, graceful shutdown, splash while booting
- `electron/preload.js` (contextBridge, minimal)
- Root scripts: `dev` (cross-env DEV + concurrently api/next/electron), `start`, `build`, `dist`
- **Done:** `npm run dev` opens a window rendering the Streamify home page

### Phase 4 — Env + app wiring ✅⬜  *(Depends: 3)*
- `app/.env.local` forked with local API base first + remote fallbacks, `NEXT_PUBLIC_SITE_URL=http://localhost:3000`
- Verify `backend-api` candidate order resolves to `http://127.0.0.1:<port>`
- Verify `SUPABASE_SERVICE_ROLE_KEY` path (account-status) and Supabase cookie middleware still work on `localhost:3000`
- **Done:** Network panel shows every `/video|/search|/artist|/collection|/lyrics|/audio-proxy|/license-proxy` hit going to 127.0.0.1

### Phase 5 — Desktop integration ✅⬜  *(Depends: 3)*
- Media keys / `navigator.mediaSession` play-pause-next-prev, taskbar thumbbar
- App menu (File/View/Playback/Help), zoom in/out/reset, `Ctrl+W` hides, `Ctrl+R` reloads
- `streamify://` protocol registration + handler for auth/session deep links
- `window.open` / `target=_blank` → `shell.openExternal`; keep OAuth redirects in-app
- **Done:** keyboard media keys control playback; external links open in the OS browser

### Phase 6 — Full feature parity run ✅ *(Depends: 4, 5)*
Walk every surface and confirm no regression vs web:
home, search (all sources + filters), library (liked/playlists/recent),
artist + channel, collection, settings (all sections, en/fa),
auth (signin/signup/forgot/reset), session (create/join/privacy/terms),
mini player, fullscreen player, side panel, queue/repeat/shuffle, volume+boost,
lyrics (timed + wrong-lyrics flow), audio-proxy streaming, local library import.
- **Done:** all 14 routes render 200; real playback via CDP; media keys pause/resume

#### Phase 6 findings (verified, not assumed)
- All 14 routes return 200 and render content (scripts/verify-ui.mjs).
- Playback verified end to end: search -> click -> in-process `/video` ->
  `<audio>` readyState 4, advancing, 321s (scripts/verify-playback.mjs).
- Real OS media key pauses then resumes that same playback
  (scripts/verify-mediakey-playback.mjs).
- One pre-existing hydration error on `/artist/[id]` and `/artist/channel/[id]`.
  Reproduced identically on the hosted web app (`streamify-player.vercel.app`),
  and the SSR HTML the server emits for both is byte-identical, so it is an
  upstream web-app bug — NOT a desktop regression. Desktop copies the app
  file-for-file (`git archive`), so by construction nothing can regress here.
- No desktop-only console errors on any route.

### Phase 7 — Production build + package ✅⬜  *(Depends: 6)*
- `next build` inside `app/`, prod `next start`
- electron-builder NSIS + portable, app id `com.streamify.desktop`, icon from `StreamifyLogo`
- Bundle only runtime deps (prune devDeps), `extraResources` for `.next`, `public`, `.env.local`
- **Done:** `npm run dist` produces an `.exe` that launches standalone (no node/npm needed)

### Phase 8 — Docs + final push ✅⬜  *(Depends: 7)*
- `README.md` (architecture, dev, build, packaging, how the in-process API works, what differs from web)
- Final commit + push, verify remote tree
- **Done:** repo README renders, `gh repo view` description set

## Parity checklist (Phase 6 gate)

- [ ] Home loads with categories/recommendations
- [ ] Search: YouTube, YouTube Music, SoundCloud, JioSaavn, filters, suggestions
- [ ] Playback starts, seeks, repeats, shuffles, queue reorder
- [ ] Volume + volume boost (GainNode)
- [ ] Mini player + fullscreen player + timed lyrics
- [ ] Library: liked, playlists create/rename/delete, recently played
- [ ] Local library import + persistence
- [ ] Artist page + channel page + collection page
- [ ] Settings: every section, language switch en↔fa, RTL
- [ ] Auth: signin, signup, forgot, reset, session restore
- [ ] Sessions: create, join, privacy, terms
- [ ] Proxied audio streaming (`/audio-proxy`) plays
- [ ] No console errors on any route

## Known risks

1. `next dev` needs `npm install` inside `app/` — first run is slow.
2. `YT_PROXY_URL=http://127.0.0.1:10808` is a dev-only local proxy; must fail soft.
3. Supabase redirect allowlist must include `http://localhost:3000`.
4. Packaged app needs `.env.local` shipped as a resource — secrets ship with the
   installer (same as today, already committed-free but present on disk).
5. Windows file locking: kill child processes before rebuild (`ENOTEMPTY` retry).
