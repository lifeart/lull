# Deploying Lull

## Architecture in one line

The two apps (**Speaker** = the old nursery device, **Controller** = the parent's phone) are static
files, but they talk to each other through a **hub** — a tiny Node + WebSocket process (one runtime
dependency, `ws`). The hub relays commands/state, owns the authoritative sleep timer, persists the
device registry, detects a device that went silent (→ parent alarm), and stores uploaded sounds.

Static hosting **cannot run the hub**. That's why the GitHub Pages **demo** substitutes an in-browser
mock hub (`BroadcastChannel`) that only connects tabs on the **same device** — great for a try-it demo,
but it is *not* real cross-device control. For that you need the hub somewhere reachable.

## Which topology? (pick one)

| Topology | Same-home Wi‑Fi | From outside the house | Always-on server | Uploads | When to use |
|---|---|---|---|---|---|
| **GitHub Pages only** (the demo) | ❌ same-device simulation only | ❌ | none | ❌ | Showcase / try-it. Not real usage. |
| **Self-hosted hub on the LAN** | ✅ | ❌ (unless exposed) | 1 tiny process | ✅ | The default. Run it on an always-on box: Raspberry Pi, Synology/NAS, an old Mac. |
| **Self-hosted hub + Cloudflare Tunnel** ⭐ | ✅ | ✅ (HTTPS, no port-forward) | 1 tiny process + `cloudflared` | ✅ | **Recommended for "public"/remote usage.** See [DEPLOY-SYNOLOGY.md](DEPLOY-SYNOLOGY.md) Option C. |
| **GitHub Pages + WebRTC + serverless signaling** | ✅ P2P (direct on one Wi‑Fi) | ⚠️ needs a **TURN** relay off-LAN | ~none (serverless signaling only) | ❌ (needs rework) | Near-serverless, but more complex and loses uploads + the authoritative timer. **Not built** — feasible, see below. |

### On the WebRTC / "no server at all" idea

Tempting, but you can't reach *zero* server:

- **WebRTC still needs signaling** (a rendezvous to exchange SDP/ICE). Static Pages can't do it → you need
  at least a **serverless** endpoint (Cloudflare Workers, Vercel) or a hosted signaling service.
- **NAT traversal:** two devices on the **same home Wi‑Fi** connect **directly** (host candidates) — no
  TURN needed, which fits the nursery case well. But controlling a device from **outside** the house may
  require a **TURN relay** (a server that carries the traffic) when direct/STUN fails.
- **What you'd give up:** uploaded sounds (no server store — would need IndexedDB/a blob store), the
  server-authoritative sleep timer + persistence, and robust offline detection. And WebRTC + signaling +
  reconnection is *more* code than the current WebSocket hub.

The transport is already abstracted (`shared/protocol.js`; `demo/mock-hub.js` swaps `WebSocket`), so a
WebRTC transport is implementable as a separate mode — but for a home app the tiny hub + a Cloudflare
Tunnel is simpler and keeps every feature.

## Auth — do you need it? (Yes, beyond a trusted LAN — and it's built in)

The hub ships a real auth model; you don't add code, you set a secret.

- **`MP_TOKEN`** (a shared secret) gates **both** device control (the `/ws` WebSocket handshake) **and**
  uploads/library management (`/api/*`), compared in constant time. Without the right token a stranger who
  finds the URL loads the page but **cannot connect or command anything** (401).
- **Fail-closed:** the hub **refuses to start** bound to a non-loopback host without `MP_TOKEN`
  (override only with `MP_ALLOW_OPEN=1` on a fully-trusted LAN). You can't accidentally run it open.
- **Origin allowlist** blocks browser cross-site WebSocket hijacking; same-origin requests (incl. a
  Host-preserving reverse proxy / tunnel domain) are allowed automatically.
- **Token delivery (do this):** open each app **once** as
  `https://your-host/controller/#t=YOUR_TOKEN` — the `#…` **fragment** keeps the secret out of server
  logs, browser-history sync, and `Referer` headers (unlike `?token=`). It's then remembered in
  `localStorage`, and the app's **"Add a room"** link carries it to the nursery device automatically, so
  you type it exactly once. (`?token=` still works as a fallback.)
- Generate one: `openssl rand -hex 24`.

### Sharing one hub across families (multi-group)

Run **one** hub for several households, each fully isolated, by setting **`MP_MULTIGROUP=1`**.

- **How it works — token = family.** Every distinct token becomes its own isolated **group**: its own
  rooms, its own controls, and its own uploaded sounds. A controller only ever sees and can command
  devices in its group; two families can even name a device the same thing without colliding; and a
  command aimed at another family's device is indistinguishable from one aimed at a device that doesn't
  exist (no cross-group probing). The group id is a **hash of the token** — there is **no accounts system
  and no server-side registry** to maintain. Trust-on-first-use: whoever holds a token *is* that group.
- **Onboarding a family** = generate a token (`openssl rand -hex 24`) and send them one link,
  `https://your-host/controller/#t=THEIR_TOKEN`. They tap it once; it's remembered, and their
  "Add a room" link carries it to their nursery devices. Each family manages its own rooms and sounds.
- **In this mode `MP_TOKEN` is not required.** A token is still required on the network — verifyClient
  rejects tokenless clients (401) unless you also set `MP_ALLOW_OPEN=1`, which lets tokenless clients
  share one common `default` group (loopback is always allowed for local dev).
- **Migrating an existing single-token hub (seamless):** if you **keep your existing `MP_TOKEN` set**
  when you turn on `MP_MULTIGROUP=1`, that one token keeps mapping to the shared `default` group — so
  all your current devices and uploaded sounds carry over unchanged. Every *other* token is its own
  isolated family group. (Turn the flag on *without* `MP_TOKEN` and every token, including your old
  one, becomes its own fresh group — your existing devices/uploads would then look like a new setup.)
- **Rotating / removing a family** = give them a new token (old token → a now-empty group). Per-token
  revocation is inherent: change the token and the old one no longer resolves to their data.
- **Caveat (same as single-token):** uploaded audio files at `/uploads/<group>/…` are obscure but not
  themselves token-gated on the raw `GET` (random ids under an 80-bit group hash), so `<audio>` playback
  needs no token on every media request. The library listing, uploads, and all mutations **are** fully
  group-gated. Don't put secrets in the audio.
- **Backward compatible:** leave `MP_MULTIGROUP` unset and the hub is the original single-group system —
  one `MP_TOKEN`, one shared library. Existing `data/` needs no migration (the default group keeps the
  flat `data/uploads/` layout; per-family groups nest under `data/uploads/<group>/`).

### For a public Cloudflare Tunnel specifically

1. **Set `MP_TOKEN`.** Necessary and sufficient as the app-level gate; the fail-closed policy enforces it.
2. **Recommended defense-in-depth: Cloudflare Access** (Zero Trust) in front of the tunnel — real identity
   auth (email OTP / SSO), so a stranger never even loads the app. **Caveat:** an *interactive* Access
   login breaks the Speaker's unattended auto-reconnect after an iOS reclaim — use an Access **service
   token**, or a **bypass rule for the player path**, so the nursery device can reconnect headless.
3. **HTTPS is automatic** with the tunnel, so the token never travels in cleartext. (On plain-HTTP LAN it
   does — fine at home, not for anything exposed.)
4. **Rotating access** = change `MP_TOKEN` (it's a single shared secret; per-user revocation needs Access).
5. Set **`MP_ORIGIN=https://your-host`** if the tunnel/proxy rewrites the `Host` header.

## Recipes

- **Synology NAS (Container Manager):** [DEPLOY-SYNOLOGY.md](DEPLOY-SYNOLOGY.md) — plain-HTTP LAN, DSM
  HTTPS reverse proxy, and the Cloudflare Tunnel option, step by step.
- **Any Docker host:** the repo's `Dockerfile` + compose run non-root with a healthcheck. Set `MP_TOKEN`
  (and `MP_ORIGIN` behind a Host-rewriting proxy). Persist `/data` for the registry + uploads (`STATE_FILE=/data/state.json`, `UPLOADS_DIR=/data/uploads`).
- **Bare Node:** `npm ci && npm run bake && MP_TOKEN=$(openssl rand -hex 24) npm start`, then open the
  apps with `#t=<that token>`.
- **Better ambient sounds (optional):** `npm run fetch:real` overlays human-cleared CC0/PD recordings for
  rain/ocean/fire/wind (downloaded audio is gitignored; synthesis is the offline fallback).
