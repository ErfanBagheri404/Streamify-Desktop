# Phase 10-11 — yt-dlp fallback resolver (YouTube only)

## Why

The YouTube chain is 4 third-party services that die constantly:
`invidious[] → piped[] → oembed → noembed`. Every one is a volunteer-run public
instance; when they all go down the app has **no way to play a track**. yt-dlp is
the only resolver that talks to YouTube directly and self-updates, so it is the
only fallback nobody can take away.

yt-dlp is **YouTube-only by design** — the request said so and the routes confirm
it: only `source === "youtube" | "youtubemusic" | !source` reaches the provider loop.
SoundCloud/JioSaavn/Deezer/Spotify keep their existing resolvers, untouched.

## Design constraints

1. **The API must stay a valid worker.** `api/src/` is vendored from
   `E:\Dev\Projects\streamifyapi`, and a Cloudflare Worker has no `child_process`.
   So the resolver lives in a **new** file `api/src/routes/ytdlp.ts` and the only
   touch to the vendored `video.ts` is one guarded call. The worker build
   (esbuild with `--platform=browser`, if ever run) can't statically include
   `node:child_process`, so the import must be **dynamic and lazy**, behind a
   desktop-only capability flag.
2. **It is the LAST resort.** Invidious and Piped are tried first because they are
   faster and need no binary. yt-dlp only runs when all of them failed.
3. **Fail soft, always.** No binary → skip silently. yt-dlp errors → skip to
   oembed. A missing fallback must never make a track unplayable that was playable
   before.
4. **Installer size.** yt-dlp is ~17MB (win) / ~30MB (mac, linux). Ship it as an
   `extraResources` payload downloaded at BUILD time (CI), not runtime: a
   runtime downloader would need a trust prompt, a write location, and an update
   path — none of which are asked for.

## Phase 10 — resolver

- `api/src/routes/ytdlp.ts`
  - `resolveYouTubeWithYtDlp(videoId, opts)` → spawns
    `yt-dlp -J --no-warnings --no-playlist --skip-download <url>`, parses the JSON
    metadata, picks the best audio format the same way `pickBestStreamUrl` does
    (prefer m4a/mp4, then opus, then highest bitrate).
  - Binary discovery, in order: `STREAMIFY_YTDLP_PATH` env (dev/tests) →
    `<resourcesPath>/bin/yt-dlp[.exe]` (packaged) → `yt-dlp` on PATH.
  - Returns the same shape the other providers return
    (`{ id, title, author, thumbnailUrl, lengthSeconds, audioUrl, relatedSongs, source }`)
    so `video.ts` needs no shape knowledge.
  - `audioUrl` goes through the existing `buildPlayableAudioUrl` helper so the
    googlevideo URL is delivered via the same `/audio-proxy` relay the other
    providers use (direct googlevideo fetches 403 without matching headers).
- `api/src/routes/video.ts` — one call site, appended to the existing `providers`
  array so the existing for-loop failover and error collection handle it for free.
- `api/tests/ytdlp.test.ts` — format-picking + binary-path resolution are pure
  functions; assert those without spawning anything.

## Phase 11 — shipping the binary

- `scripts/fetch-ytdlp.mjs` — downloads the right binary per platform into
  `resources/bin/`, chmod +x on posix. Skips if present; `--force` re-downloads.
- `package.json` — `extraResources` entry + `prepare:ytdlp` wired into `build`.
- `.github/workflows/build.yml` — run the fetch step before `electron-builder` on
  all three OSes.
- Electron resolves it via `process.resourcesPath` — no main.js change needed
  because the API bundle reads the path itself.

## Known risks

1. **macOS notarization.** A nested unsigned `yt-dlp_macos` inside the app bundle
   breaks `codesign --verify` under notarization. The current release is unsigned
   (no identity configured), so this only matters if signing is added later —
   then it needs `--deep` or an `afterSign` fixup.
2. **yt-dlp goes stale** when YouTube changes extraction. The version is pinned in
   `scripts/fetch-ytdlp.mjs`; bump it, and CI ships the new one.
3. **403 from googlevideo** if the picked format needs a client identity
   (`po_token`). yt-dlp's default client works for audio-only formats; if a future
   YouTube change breaks that, the failure surfaces as a normal track error and
   the chain still falls through to oembed metadata.

## Done criteria

- [ ] `api/tests/ytdlp.test.ts` passes
- [ ] `npm run check` (tsc on api) clean
- [ ] All 15 routes still render in the running desktop app
- [ ] A YouTube track still plays end-to-end with the fallback present
- [ ] Committed, not pushed
