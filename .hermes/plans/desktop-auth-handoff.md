# Desktop auth handoff (browser-mediated device grant)

Goal: desktop never collects credentials. Login/signup/reset happen in the real
webplayer (`https://streamify-player.vercel.app`), which hands a short-lived,
single-use grant back to the app via a custom protocol. No token in a URL.

## Why not the obvious things

- **In-app browser form** (today): works, but it is a second auth surface — the
  user types credentials into an Electron window, and the session is stranded
  there. Replaced.
- **`streamify-desktop://...?access_token=...`**: refresh/access token in a URL
  lands in shell history, the browser's URL bar, and any handler log. Rejected.
- **Polling device-code flow** (RFC 8628): needs a server-side store for the
  pending code. We have no KV/Redis. Rejected in favour of a signed grant.

## Design: stateless signed grant + PKCE

Nothing is stored server-side, so no new infrastructure. Two independent
secrets are required to turn a grant into a session:

1. **HMAC signature** on the grant — unforgeable without the server secret.
2. **PKCE `code_verifier`** — known only to the desktop process.

An attacker who intercepts the deep link still cannot redeem it (no verifier),
and an attacker who guesses a verifier still cannot forge a grant (no key).

### Grant payload (signed, not encrypted)

```
{ sub, aud: "streamify-desktop", exp: now+120s, jti, nonce, challenge }
```

`challenge = base64url(SHA256(verifier))`. The verifier never leaves the app
until redeem. `nonce` is echoed through the browser and checked constant-time
on return, binding the response to this app instance.

### Flow

```
desktop  -> shell.openExternal( WEB/auth/desktop?challenge&state&next )
WEB      -> no session? 302 -> WEB/signin?next=/auth/desktop?...
         -> session?   confirm page ("Authorize Streamify Desktop?")
WEB      -> POST /api/auth/device/approve  (session-gated)
         -> 302 streamify-desktop://auth?grant&state
OS       -> app open-url / second-instance
desktop  -> POST WEB/api/auth/device/token { grant, verifier }   (from main)
WEB      -> verify HMAC + exp + aud + S256(verifier)==challenge
         -> admin.generateLink(magiclink, email) -> hashed_token
desktop  -> renderer: supabase.auth.setSession({ token_hash })   via IPC
```

### Endpoints

- `GET /auth/desktop` — confirm page. Requires a session. Renders the device
  name + an Authorize button. A human confirms, so a page that merely *links*
  here cannot silently mint a grant.
- `POST /api/auth/device/approve` — mints and 302s the grant.
- `POST /api/auth/device/token` — verifies and returns a magic-link
  `token_hash`. The renderer exchanges it for a session with `verifyOtp`; the
  token is never a session token in transit.

### Threat model

| Attack | Blocked by |
|---|---|
| Malicious page links to `/auth/desktop` | confirm page + explicit user action |
| Attacker reads the deep link from logs/history | grant is single-use, 120s, and needs the verifier |
| Malicious app registers the scheme | PKCE verifier mismatch |
| Forged grant | HMAC over payload |
| Replayed grant | `exp` + `jti` burn (single-use, in-memory, per-process) |
| Open redirect via `next`/redirect params | redirect target is **hardcoded** to `streamify-desktop://auth`; `next` must start with `/` and not `//` |
| Token exfiltration from the renderer | no tokens in URLs, IPC only, renderer is our own localhost origin |
| SSRF via `next` | only same-origin paths reach `new URL(next, origin)` |
| CSRF on approve | session cookie is `SameSite=Lax`; approve is a POST |

### Ceilings (deliberate)

- `ponytail:` grant burn list is in-memory per server instance. On a
  multi-instance deploy a replay could land on another instance. Add Redis/KV
  keyed by `jti` if the webplayer ever scales out.
- `ponytail:` desktop session lives in the Electron profile's cookie jar
  (plaintext on disk, same as any browser). Add `safeStorage` wrapping if the
  threat model ever includes local disk access.
- HMAC key derives from `SUPABASE_SERVICE_ROLE_KEY` when
  `STREAMIFY_DEVICE_SECRET` is unset, so no new required config.

## Tasks

1. Webplayer: `lib/device-grant.ts` (sign/verify, no I/O) + unit tests.
2. Webplayer: `/auth/desktop` confirm page.
3. Webplayer: `/api/auth/device/approve` mint route.
4. Webplayer: `/api/auth/device/token` redeem route.
5. Webplayer: signin/signup/forgot honour `?next=` (validated).
6. Desktop: protocol registration (dev + packaged) + hardened deep-link parse.
7. Desktop: handoff controller in main (PKCE, redeem, nonce check).
8. Desktop: preload IPC + renderer `setSession`.
9. Desktop: `AuthScreen` external-flow branch.
10. Locales en + fa.
11. Security audit pass, fix findings.
12. Tests, typecheck, e2e, commit (no push).
