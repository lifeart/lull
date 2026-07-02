# mesh-playback

Turn old iPhones/iPads on your home network into **remotely-controlled speakers** — built entirely in web tech (no native app per iOS version). Primary use: **start/stop/adjust white noise for a child from your own phone.**

> **New here?** Start with [`docs/HANDOFF.md`](docs/HANDOFF.md) — status, how to run/test/deploy, architecture map, invariants, honest limits, and next steps.

> **🔧 Live demo (no install):** the Player and Controller PWAs run on GitHub Pages against an
> **in-browser mock hub** — a leader-elected `BroadcastChannel` hub running the project's real
> shared protocol, so the two apps genuinely talk to each other with no server. Arm the Speaker,
> then drive it from the Controller. Build it locally with `npm run build:demo` (output in `_site/`,
> serve over any static server); it deploys automatically via [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
> The demo shows the control plane, tiers, timer, and parent-phone alarm; it can't reproduce true
> iOS background/lock behavior (that needs a real device — see the limits below).

> Status: **MVP complete and production-hardened** (hub + Player PWA + Controller PWA, "always-audible" model with capability-gated remote volume on modern devices), through five adversarial review rounds; **83 node + 12 real-browser tests green**, container deploy path verified end-to-end. The one remaining unknown is the real-iOS-hardware overnight soak. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture, the iOS constraints that shape it, and the build plan (milestones M1–M8), and [`docs/HANDOFF.md`](docs/HANDOFF.md) for current status + what round 5 changed.

## The one thing to understand first

iOS **will not let a web page start audio on a locked, idle device from a network message or a push notification.** Audio needs a one-time user *tap* to unlock, and a backgrounded Safari tab gets suspended (killing its network connection) unless audio is *actively playing*.

So the design does **not** try to "wake a silent iPad and make it play." Instead:

- You **arm each device once** with a single tap. That tap unlocks audio and starts a seamless looping noise file that **keeps playing** (audibly, or silently on capable hardware).
- After that, your phone remotely **starts / stops / fades / sets a sleep-timer** on it, because the always-running audio keeps the device reachable.
- Reliability comes from **detecting failures on your (awake) phone and alarming you**, not from magically reviving a dead nursery device at 3 a.m.

## Architecture at a glance

```
  Parent's phone                Always-on hub               Old iPad (nursery)
 ┌───────────────┐   command   ┌───────────────┐  command  ┌────────────────┐
 │ Controller PWA │──────────▶ │  Hub server    │─────────▶│  Player PWA     │
 │ (start/stop,   │◀────────── │  • HTTPS (TLS)  │◀─────────│  • looping <audio>
 │  volume, timer,│   state     │  • WS relay     │   state  │  • Web Audio gain
 │  alarms)       │            │  • desired/     │          │  • MediaSession  │
 └───────────────┘            │    reported     │          │  • auto-reconnect│
                              │    state store  │          └────────────────┘
                              │  • bakes noise  │
                              └───────────────┘
```

- **Hub** — a tiny always-on box (Raspberry Pi / NAS / Mac mini / spare laptop) that serves the two web apps over real HTTPS, relays commands, and is the single source of truth for state.
- **Player PWA** — runs on each old iPhone/iPad; the "speaker."
- **Controller PWA** — runs on the parent's current phone; the remote.

## Run it

```bash
npm install                       # runtime dep: ws
npm run bake                      # generate seamless white/pink/brown loops + PNG app icons
npm start                         # hub on http://localhost:8080
npm test                          # 80 node tests: protocol, seams, audio engine, hub, static, auth, store, hardening
npx playwright install chromium   # once, for the browser e2e
npm run test:e2e                  # 12 real-browser tests: arm, start/stop, volume, timer, alarm, soundscape, upload, reorder, forget
```

**Sounds:** white / pink / brown noise are built in. From the Controller's **Sounds** card you can
add your own audio (a lullaby, a recording; ≤30 MB) with **＋ Add sound** or by **dragging a file
onto the card** — it's stored on the hub and becomes a selectable sound on every device, and you can
**rename or delete** it under “Your sounds”. Devices show a **now-playing waveform** while playing.
Switching a sound while a device is backgrounded is deferred until it's foregrounded (iOS-safe).

**Security:** the control channel (WebSocket **and** the state-changing `/api` routes) is protected
by an Origin allowlist plus an `MP_TOKEN` shared secret. The hub **fails closed**: bound to a real
network interface it refuses to start without `MP_TOKEN` (set `MP_ALLOW_OPEN=1` to override on a
trusted LAN; `localhost` is exempt for dev). Generate one with `openssl rand -hex 24` and open the
apps once with `…/controller/#t=YOUR_TOKEN` (persists to the device). Uploads are streamed to disk
with a size cap and concurrency limit; the container runs as a non-root user with a health check.

- On this machine: open `http://localhost:8080/controller/` and, in another tab, `http://localhost:8080/player/` → name it, tap **Arm**, then drive it from the controller. (`localhost` is a secure context, so it all works without certs on the dev box.)
- On a **real iPhone/iPad** you need HTTPS (service worker / audioSession / wake lock require a secure context). Set up Caddy + DNS-01 + split-horizon DNS — see [`deploy/`](deploy/) and [`docs/DESIGN.md`](docs/DESIGN.md) §1.6. Then harden each device ([`docs/HARDENING.md`](docs/HARDENING.md)) and run the [overnight test](docs/OVERNIGHT-TEST.md) before trusting it.

**Delivery beyond baked noise:** HLS (send any/long audio, same background-safe path) and WebRTC (live "talk to / listen into" the room) are analyzed in `docs/DESIGN.md` §12 and scheduled as milestones M7/M8 — both reuse this same hub, protocol, and safety net.

## Why not AirPlay / Chromecast / a native app?

- **iOS devices can't receive AirPlay** — they only *send* it. You cannot AirPlay *to* an old iPhone.
- **Native app** = rebuild/re-sign per iOS version and per device — exactly what you want to avoid.
- **Web tech** works on every iOS from ~12 to current from one codebase, at the cost of the background-audio constraints documented in [`docs/DESIGN.md`](docs/DESIGN.md).

## Closest prior art (worth stealing from)

**Snapcast + its browser client "Snapweb"** already turns any browser into a server-controlled, time-synced audio renderer, and **Home Assistant + Music Assistant** already provide a remote-control plane. If you're open to self-hosting those, a large part of this is solved — see the "Prior art" section in the design doc. mesh-playback is the from-scratch, purpose-built alternative focused on the old-iOS-as-nursery-speaker case.
