# Deploying on a Synology NAS (Container Manager)

Short version: **you can skip TLS for a local-home setup** and it will work — but you trade away the
"modern" features. Synology also makes real HTTPS unusually easy, so read both options before deciding.

Use [`deploy/docker-compose.synology.yml`](../deploy/docker-compose.synology.yml) (hub only, no Caddy).

---

## Do you actually need TLS?

The core of mesh-playback — a looping white-noise `<audio>` element that keeps playing while the
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

If you want the modern features, use HTTPS (Option B below) — on Synology it's a few clicks.

---

## Option A — Plain HTTP on the LAN (simplest)

1. **Container Manager → Project → Create.** Put the repo on the NAS (or pre-build the image) and use
   `deploy/docker-compose.synology.yml`. Create the data folder first, e.g. `/docker/mesh-playback`.
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
trusted, zero port-forwarding, iOS 15+.

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
