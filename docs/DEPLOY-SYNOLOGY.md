# Deploying on a Synology NAS (Container Manager)

Short version: **you can skip TLS for a local-home setup** and it will work — but you trade away the
"modern" features. Synology also makes real HTTPS unusually easy, so read both options before deciding.

Use [`deploy/docker-compose.synology.yml`](../deploy/docker-compose.synology.yml) (hub only, no Caddy).

---

## Getting the image onto the NAS (Podman build — recommended)

You don't need the repo or a Node toolchain on the NAS. Build the image on your laptop with
**Podman** and ship a single tarball:

```bash
./deploy/podman-build.sh            # → deploy/lull-hub.tar   (default arch: linux/amd64)
# ARM Synology instead?  ./deploy/podman-build.sh --platform linux/arm64
```

Then load it on the NAS (SSH, or **Container Manager → Image → Import**) and bring the project up:

```bash
docker load -i lull-hub.tar
docker compose -f deploy/docker-compose.synology.yml up -d
```

> **The `localhost/` gotcha this solves.** `podman build -t lull-hub` stores the image as
> `localhost/lull-hub` — Podman prefixes every short, locally-built name with the `localhost/`
> registry, and that prefix survives `podman save`. Loaded as-is, the image is
> `localhost/lull-hub:latest`, so the compose `image: lull-hub:latest` won't match (Container Manager
> then tries to *pull* `lull-hub` and fails). `deploy/podman-build.sh` strips the prefix from the
> saved archive, so it lands as a clean, bare **`lull-hub:latest`** the compose file references directly.
>
> **Match the arch.** Most Container-Manager Synology models are x86_64 — hence the `linux/amd64`
> default. Building the wrong arch loads fine but exits 1 at runtime. (`docker load` on a mismatched
> NAS is the tell.)

*(Alternative: build on the NAS itself — put the repo there and swap `image:` for `build:` in the
compose file. Podman is the paved road because it keeps the NAS clean.)*

---

## Do you actually need TLS?

The core of Lull — a looping white-noise `<audio>` element that keeps playing while the
screen is locked, driven remotely over WebSocket (start / stop / sleep-timer / soundscape) with the
parent-phone failure alarm — **works over plain `http://` in a Safari tab.** Plain `<audio>` playback,
its lock-screen survival in a *tab*, and `ws://` do not require a secure context.

A **secure context (HTTPS, or `http://localhost`) is required only for these extras** (iOS exposes the
APIs only over HTTPS, and the app feature-detects them, so it degrades cleanly when they're absent):

| Feature | Needs HTTPS? | If you run plain HTTP |
|---|---|---|
| Looping noise, survives screen lock (Safari **tab**) | No | ✅ works |
| Remote start/stop/sleep-timer/soundscape over WebSocket | No | ✅ works |
| Parent-phone bedtime pre-flight + failure alarm | No | ✅ works |
| **Remote software volume + click-free fades** (GainNode) | **Yes** (`audioSession`) | ❌ hidden; set volume with the device's hardware buttons |
| **Play over the ring/silent switch** (`audioSession='playback'`) | **Yes** | ❌ ring switch must be ON, volume up |
| Screen Wake Lock API (keep display awake) | **Yes** | ❌ use Settings → Auto-Lock = Never / Guided Access instead |
| Offline app-shell cache / installable standalone PWA | **Yes** (service worker) | ❌ run it in a Safari tab (fine — tab mode is what survives lock anyway) |
| Web Push (not used in the MVP) | Yes | — |

**Bottom line:** plain HTTP gives you exactly the **Tier-Legacy / Tier-Mid** experience the design
already treats as the reliable core: *always-audible, volume calibrated once with the hardware
buttons, remote start/stop + timer.* You lose the **Tier-Modern** niceties (on-screen volume, fades,
over-mute). Every device will report tier **MID** (or **LEGACY**) — never MODERN — over plain HTTP.

If you want the modern features, use HTTPS. On a NAS you have three low-friction paths:
- **Option B — DSM reverse proxy + Let's Encrypt:** LAN-local TLS, keeps working if the internet drops.
- **Option C — Cloudflare Tunnel:** zero port-forwarding, trusted cert, works on iOS 12–14, adds remote
  access — but puts your home internet in the path for control.
- **Tailscale:** peer-to-peer (LAN-direct), trusted cert, needs the app on each device (iOS 15+).

---

## Option A — Plain HTTP on the LAN (simplest)

1. **Get the image on the NAS** (see [Podman build](#getting-the-image-onto-the-nas-podman-build--recommended)
   above), then **Container Manager → Project → Create** with `deploy/docker-compose.synology.yml`.
   Create the data folder first, e.g. `/docker/lull`.
2. Set a token (recommended even on the LAN): in the project's environment, `MP_TOKEN=<openssl rand -hex 24>`.
   Or, for a fully-trusted LAN, `MP_ALLOW_OPEN=1` and no token. (The hub **refuses to start** bound to a
   real interface with neither — that's intentional.)
3. Start it. On each device open **`http://<nas-ip>:8080/player/`** in **Safari** (not "Add to Home
   Screen" — a plain tab), name it, and tap **Arm**. Open **`http://<nas-ip>:8080/controller/`** on
   your phone. If you set a token, open the apps once as `…/controller/#t=YOUR_TOKEN` (it persists).
4. Harden each device per [`HARDENING.md`](HARDENING.md): Auto-Lock = Never (or Guided Access), ring
   switch on with volume up, plugged in, Low Power Mode off.

You do **not** need `MP_ORIGIN`: the hub accepts same-origin requests, so `http://<nas-ip>:8080` and
a Host-preserving reverse proxy work with no extra config.

> **HTTP caveat:** on plain HTTP the `MP_TOKEN` travels in the URL/WebSocket in the clear on your LAN.
> That's usually fine at home; if it isn't, use Option B.

---

## Option B — HTTPS via DSM's built-in reverse proxy + Let's Encrypt (recommended)

Synology can hand you a **publicly-trusted certificate with no per-device install**, which restores the
full Tier-Modern experience. No Caddy needed — DSM does it.

1. **Free hostname:** Control Panel → External Access → **DDNS** → add a `*.synology.me` name
   (e.g. `mynas.synology.me`). *(Or use your own domain.)*
2. **Certificate:** Control Panel → Security → **Certificate** → Add → *Get a certificate from Let's
   Encrypt* → use the DDNS hostname.
3. **Reverse proxy:** Control Panel → Login Portal → Advanced → **Reverse Proxy** → Create:
   - Source: `https` · `mynas.synology.me` · port `443`
   - Destination: `http` · `localhost` · port `8080` (the hub container)
   - In **Custom Header**, enable the **WebSocket** header preset (needed for `/ws`).
4. **Split-horizon DNS (so it works offline on the LAN):** point `mynas.synology.me` at the NAS's LAN
   IP on your router's DNS (or a local override). DSM's DDNS resolves to your WAN IP by default, which
   still works if the NAS is reachable, but a LAN override avoids a round-trip and survives WAN outages.
5. Open **`https://mynas.synology.me/player/`** and `…/controller/` on the devices — padlock, no cert
   profile, and MODERN-tier features (on-screen volume, fades, over-mute) light up on iOS 16.4+.

DSM's reverse proxy preserves the `Host` header, so the hub's same-origin check passes with no
`MP_ORIGIN`. If you front it with something that rewrites Host, set `MP_ORIGIN=https://mynas.synology.me`.

*Alternative:* install the **Tailscale** package on the NAS and use its `*.ts.net` hostname + cert —
trusted, zero port-forwarding, but needs the Tailscale app on every device (iOS 15+).

---

## Option C — Cloudflare Tunnel (built-in TLS, no port-forwarding, works on iOS 12–14)

A **Cloudflare Tunnel** (`cloudflared`) makes an *outbound-only* connection from the NAS to Cloudflare's
edge — **no inbound ports, no firewall holes** — and serves your hub under a Cloudflare-managed,
publicly-trusted certificate. It needs **no per-device app or cert install**, so it's the easiest
zero-setup HTTPS that also covers the **oldest iPhones/iPads (iOS 12–14)**. WebSockets are supported
automatically, so `/ws` just works.

**The trade-off to weigh for a nursery device:** a tunnel routes *all* traffic (even LAN-local) through
Cloudflare's edge over the internet. So if **your home internet is down, remote control and the
parent-phone alarm relay stop** until it's back — the **already-playing white noise keeps playing** (it's
a local `<audio>` loop that doesn't need the hub), but you can't start/stop/re-check it, and a device
failure wouldn't relay to your phone. If you want control to survive a WAN outage, prefer Option B
(LAN-local TLS) or Tailscale (peer-to-peer, connects directly on the LAN). If your uplink is reliable
and you also want to control the rooms from *outside* the house, the tunnel is excellent.

**Setup (remotely-managed / token tunnel — no config file):**
1. Add your domain to Cloudflare (free plan is fine).
2. **Zero Trust dashboard → Networks → Tunnels → Create tunnel → Docker.** Copy the tunnel **token**.
3. Run `cloudflare/cloudflared` on the NAS with that token (see the commented `cloudflared` service in
   [`deploy/docker-compose.synology.yml`](../deploy/docker-compose.synology.yml) — put it on the same
   Docker network as the hub so it can reach `http://hub:8080`).
4. In the tunnel's **Public Hostname** page: hostname `nursery.example.com` → service `http://hub:8080`.
5. On the hub, set **`MP_ORIGIN=https://nursery.example.com`** (the tunnel is a Host-rewriting proxy, so
   the same-origin shortcut may not apply — the allowlist entry makes it explicit and reliable).
6. Open `https://nursery.example.com/player/` and `…/controller/` on the devices. Trusted padlock,
   MODERN-tier features on iOS 16.4+, and it reaches the rooms from anywhere.

With a pure tunnel you don't even need to publish port 8080 on the NAS — nothing is exposed on the LAN
or WAN except the outbound tunnel. Because the hostname is public, **keep `MP_TOKEN` set** (it's the gate
that stops a stranger with the URL from driving your speakers). For an extra lock, put a **Cloudflare
Access** policy in front — but note an *interactive* Access login breaks the player's unattended
auto-reconnect, so use an Access **service token** (or a bypass rule for the player path) if you add it.

---

## Notes

- **Volume permissions just work:** the container starts its entrypoint as root, `chown`s `/data` to
  its unprivileged `node` user, then drops privileges — so Synology's bind-mount ownership doesn't
  cause the "everything 403s / won't persist" problem. The app process never runs as root.
- **Health:** the image has a `HEALTHCHECK` (`/healthz`); Container Manager shows the container health.
- **Backups:** everything stateful lives under the mounted `/data` (device registry + uploads) — back
  up that one folder.
- **Overnight test:** before trusting it unattended, run [`OVERNIGHT-TEST.md`](OVERNIGHT-TEST.md) on a
  real device — that's the one thing no amount of configuration can substitute for.
