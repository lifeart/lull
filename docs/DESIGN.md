# mesh-playback — Design & Research

Remotely play/control audio (primarily **white noise for a child**) on **old iPhones/iPads** on the home LAN, using **web tech only** (no per-iOS-version native builds).

This document is the output of a research + adversarial-design pass. It records the hard platform constraints, the resulting architecture, an honest statement of what is and isn't achievable, and a staged build plan.

---

## 1. The constraints that dictate everything

These are verified against WebKit/Apple docs, bug trackers, and MDN (sources inline). They are not opinions — they are why the design looks the way it does.

### 1.1 Audio needs a one-time user gesture
- On iOS, audible playback requires a **user gesture** (tap/click) to start. A muted `<video>` is the only thing that autoplays.
- The gesture is needed **once, to "unlock"** — after that, start/stop/volume can be driven entirely by script (e.g. a WebSocket message). ([WebKit autoplay policy](https://webkit.org/blog/6784/new-video-policies-for-ios/), [mattmontag unlock notes](https://www.mattmontag.com/web/unlock-web-audio-in-safari-for-ios-and-macos))
- `AudioContext.resume()` **must be called synchronously inside the gesture handler** — not after an `await`.

### 1.2 `HTMLAudioElement` survives lock; raw Web Audio does not
- An **`<audio>` element keeps playing** when the tab is backgrounded or the screen is locked.
- A raw **`AudioContext` is "ambient"** and is **suspended/silenced the moment the screen locks**, and is **muted by the hardware ring/silent switch**. ([WebKit bug 198277](https://bugs.webkit.org/show_bug.cgi?id=198277))
- ⇒ **The sound that must survive overnight MUST come from an `<audio>` element**, not from a generated Web Audio noise buffer.

### 1.3 Volume, mute-switch, and gapless are in tension
- iOS **ignores `HTMLMediaElement.volume`** — the only way to do remote volume/fades is to route the element through a Web Audio **`GainNode`**. But routing through Web Audio re-exposes it to the "ambient" fragility above on some iOS builds (notably an **unfixed iOS 17.5.1–17.6.1 bug** that permanently stops Web Audio after focus loss).
- **Gapless looping** requires Web Audio scheduling; a looping `<audio src>` has an audible seam. You **cannot** get seamless-loop + background-survival from the same mechanism — so we **pre-bake a seamless crossfaded loop file** and loop *that* via `<audio>`.
- `navigator.audioSession.type = 'playback'` (iOS **16.4+**, feature-detected) makes audio background-capable **and plays over the mute switch** — the ideal lever where available. On older iOS, the "silent-`<audio>` unmute trick" is the fallback.

### 1.4 A backgrounded iOS tab is suspended — every transport dies identically
- When the tab backgrounds/locks, **JS is frozen**: WebSocket, SSE, long-poll, and WebRTC **all freeze the same way**. A frozen WebSocket fires **no `close` event** and `send()` silently fails — you'll *think* you're connected.
- An actively-playing `<audio>` element **keeps the tab resident longer** (the "keep-alive" trick), but iOS still drops idle sockets (~5 min) and can reclaim the tab under memory pressure. ⇒ reliability = **app-level heartbeat + reconnect-on-foreground + full state resync**, never trust the socket object.

### 1.5 Web Push **cannot** start audio on iOS
- Push works only on **iOS 16.4+** and **only for a Home-Screen-installed PWA**. Every push **must** show a visible notification (no silent/data pushes — the subscription gets revoked otherwise).
- A push **cannot run code that starts audio**: the service worker has no DOM/`<audio>`, and autoplay needs a gesture. The best achievable is *"notification → user taps → app opens (that tap is the gesture) → audio starts."*
- ⇒ **"push wakes the iPad and it starts playing"** is **impossible** in pure web tech. Push is only useful to alert the *parent's* phone.

### 1.6 HTTPS/secure-context is mandatory and is the biggest friction point
- Service workers, Web Push, Wake Lock, and `audioSession` all require a **secure context**. `http://<lan-ip>` and `http://host.local` are **not** secure (only `http://localhost` is exempt).
- Getting an **iOS-trusted** cert on a LAN is the hardest setup step. Options, best→worst friction:
  - **Real domain + Let's Encrypt DNS-01 wildcard + split-horizon LAN DNS** — publicly trusted, **works down to iOS 9, zero device-side install.** *(recommended primary)*
  - **Tailscale + MagicDNS (`*.ts.net`)** — trusted, zero cert profile, but **iOS 15+ only**, needs the Tailscale app on every device, and needs internet for cert renewal.
  - **mkcert / `caddy internal` self-signed** — requires a fiddly **two-step trust toggle on every device** that people routinely get wrong. Fine for 1–2 personal devices only.

### 1.7 Old-device capability tiers (feature-detect, never version-sniff)

| Capability | iOS 12 | 13–14 | 15.4 | 16.4 | 17 | 18.4+ |
|---|---|---|---|---|---|---|
| Service worker / manifest / offline cache (HTTPS only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `<audio>` background/lock playback in **Safari tab** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `<audio>` background in **standalone PWA** | ✗ | ✗ | ✓ (15.4) | ✓ | ✓ | ✓ |
| MediaSession (lock-screen controls) | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| `navigator.audioSession` (over-mute playback) | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Web Push (installed PWA only) | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Screen Wake Lock (Safari tab) | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Screen Wake Lock (installed PWA) | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (18.4) |
| Background Sync / Periodic Sync / Background Fetch | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

**Hardware ceilings:** iPhone 5s/6, iPad Air 1, iPad mini 2/3 → **iOS 12.5** (often 1 GB RAM). iPhone 6s/SE1/7, iPad Air 2, iPad mini 4 → **iOS 15.8**. iPhone 8/X → **iOS 16.7**. iPhone XR/XS+ → iOS 17/18+.

**Practical floor:** **iOS 15.4** is where an audio PWA is genuinely usable (working standalone background audio + MediaSession). iOS 12–14 degrade to "audible loop + start/stop + timer, fixed volume." **1 GB devices should be attended/best-effort only.**

---

## 2. The honest limitation (read this before building)

An adversarial stress-test (iOS-internals, non-technical-parent, seam-integrity, and old-device lenses) killed the naïve "silent-then-remotely-start on a locked old iPhone" promise. The verdict:

> **You cannot guarantee "start white noise from silence on a locked, idle *old* device at 3 a.m."** Over an 8-hour night, iOS memory pressure can reclaim the tab; after any reload, audio is re-locked and needs a physical tap that no remote command or push can supply.

Therefore the design is **tiered by honesty**, not by wishful features:

- **Tier-Legacy (iOS 12–15.3, esp. 1 GB):** model is **"always-audible night-light for sound."** One pure `<audio>` loop plays all night at a **volume calibrated once at setup**. Remote control = **sleep-timer + stop** only. No remote cold-start-from-silence. 1 GB devices: attended only.
- **Tier-Mid (15.4–16.3):** reliable standalone background audio + MediaSession; **volume fixed at arm time** (no over-mute session, no guaranteed gain-over-lock).
- **Tier-Modern (16.4+, ≥2 GB, plugged, standalone):** the **full product** — GainNode remote volume + click-free fades, `audioSession='playback'` over the mute switch, MediaSession lock-screen controls, Wake Lock, and best-effort silent keep-alive + remote adjust while locked.

**The reliability strategy that makes this shippable:** move all failure detection to the **parent's phone** (which is awake and holds a valid audio gesture). Every command demands an **ACK within ~3 s**; a mandatory **bedtime pre-flight** refuses to show "green" until every device answers; a dead device triggers a **loud alarm + haptic on the parent's phone** — converting invisible 3 a.m. failures into fixable-before-bed ones.

---

## 3. Architecture

### 3.1 Components

| Component | Runs on | Responsibility |
|---|---|---|
| **Hub server** | always-on LAN box (Pi/NAS/Mac mini/laptop) | Serves both PWAs, WebSocket relay, **desired/reported** state store (SQLite WAL), device registry, hub-owned sleep-timer, origin for baked noise files. Single source of truth. |
| **Caddy (TLS)** | same box | Terminates HTTPS with an iOS-trusted cert; keeps media `Range`/206 intact. |
| **Player PWA** | each old iPhone/iPad | The "speaker": arm gesture, pure `<audio>` loop (background substrate), optional GainNode (Tier-Modern), MediaSession, WS client + heartbeat + recovery state machine, reports capabilities + state. |
| **Controller PWA** | parent's current phone | Lists devices w/ live state; issues start/stop/volume/timer; runs pre-flight; **alarms the parent** on ACK-timeout/stale device. |
| **Setup wizard** | parent's phone (hub-served) | QR handoff, test-tone volume calibration, per-device iOS hardening checklist, Shortcuts autostart. |
| **Noise pipeline** | hub, at setup time | ffmpeg/sox bakes a **seamless crossfaded ~60 s loop** (lossless WAV over LAN + HE-AAC alt) + N loudness variants + `manifest.json`. Offloads all DSP from weak devices. |

### 3.2 End-to-end command flow

1. Parent (foreground Controller) taps **Nursery → Start, 30%, 45-min timer**.
2. Controller → hub WS: `{type:'command', target:'nursery', verb:'start', gainLinear:0.30, cmdId:'…'}` (+ a `setTimer` with an absolute deadline).
3. Hub validates, writes it to **desired** state for `nursery`, relays to that player's socket (alive because its loop keeps the tab resident), and starts a **hub-owned countdown** to the absolute deadline.
4. Player (already unlocked at arm time — **no new gesture**) ramps the GainNode 0→0.30 over ~1.5 s. On Tier-Legacy the loop is simply already audible at the calibrated volume; "start" un-mutes / confirms.
5. Player updates MediaSession + posts `{type:'report', state:'playing', gainLinear:0.30, remainingSec:2700}` and an **ACK** echoing `cmdId`.
6. Hub records **reported** state, broadcasts to the Controller → UI shows "Playing · 30% · 44:59". If the ACK doesn't arrive in ~3 s, the Controller **alarms the parent**.
7. At the deadline the **hub itself** flips desired → `{verb:'stop', reason:'timer'}` and pushes an authoritative snapshot — so a later reconnect deterministically computes "already elapsed → stopped" and **never resurrects the noise**.

### 3.3 Key decisions (with rejected alternatives)

- **Central LAN hub, not browser P2P/WebRTC.** Browsers can't do mDNS discovery and WebRTC still needs signaling + suffers the same backgrounding death; a hub also gives a resync source of truth and a place to terminate TLS. *(Rejected: pure P2P/WebRTC.)*
- **HTTPS via real domain + Let's Encrypt DNS-01 + split-horizon DNS (primary); Tailscale optional.** Only the DNS-01 path works on iOS 12–14 with zero device setup. *(Rejected as *primary*: Tailscale — iOS 15+ floor; self-signed — two-step per-device trust.)*
- **Sound = one looping `<audio>` of a pre-baked seamless file; GainNode only on Tier-Modern; never src-swap while backgrounded.** Only `<audio>` survives lock; iOS ignores element volume; src-swap breaks lock playback on iOS 15+. *(Rejected: pure Web Audio noise — dies on lock; src-swap for volume — breaks background.)*
- **The background substrate is ALWAYS a pure *unrouted* `<audio>` element.** GainNode is layered as best-effort remote volume on Tier-Modern only, and is explicitly **not** the keep-alive — this removes the self-contradiction (needing Web Audio for volume vs. needing to avoid Web Audio for lock survival).
- **Control = WebSocket + app-level heartbeat + reconnect on `visibilitychange`/`pageshow`/`online` + full-state resync.** Because every transport freezes identically when suspended. *(Rejected: push-as-command — can't start audio; SSE+POST kept as viable fallback.)*
- **Sleep-timer is hub-owned as an absolute `endsAtEpochMs` in desired state.** Prevents the "resync resurrects noise" fatal.
- **Failure detection lives on the parent's phone**, with mandatory bedtime pre-flight + loud alarm. Because you can't recover a suspended nursery tab remotely — you can only alert the awake human.

---

## 4. Wire protocol (shared contract — the anti-seam-drift layer)

One shared module (`/shared/protocol`) is imported by hub, player, and controller so no layer can disagree on names/units/verbs. Units are **baked into field names**.

```jsonc
// Player → Hub on connect
{ "type": "hello", "role": "player", "deviceId": "nursery-ipad-air2",
  "friendlyName": "Nursery", "caps": { "tier": "MID", "audioSession": false,
  "gainNode": true, "wakeLock": false, "mediaSession": true } }

// Hub → Player: authoritative full state (sent on EVERY connect — replace-all)
{ "type": "stateSnapshot", "deviceId": "nursery-ipad-air2",
  "desired": { "verb": "start", "gainLinear": 0.30, "soundscape": "white",
  "endsAtEpochMs": 1751408100000 }, "serverEpochMs": 1751405400000 }

// Controller → Hub, Hub → Player: incremental command (merge delta), needs ACK
{ "type": "command", "target": "nursery-ipad-air2", "verb": "setGain",
  "gainLinear": 0.15, "cmdId": "c-8f3a" }
// verbs: start | stop | setGain | setTimer | setSoundscape

// Player → Hub: telemetry (player-owned; never mutates desired)
{ "type": "report", "deviceId": "nursery-ipad-air2", "state": "playing",
  "gainLinear": 0.30, "remainingSec": 2700, "cmdId": "c-8f3a" }
// state: playing | stopped | requires_gesture | error

// Player → Hub: heartbeat every 20–30s; missed pong ⇒ terminate + reconnect
{ "type": "ping", "deviceId": "nursery-ipad-air2" }
```

Rules that prevent the flagged fatals:
- **`desired` (controller-owned intent)** and **`reported` (player-owned telemetry)** are stored separately; players conform to desired and **never mutate it**.
- **`stateSnapshot` replaces all**, sent on every (re)connect → a reconnect after any outage is always correct.
- Timer is an **absolute `endsAtEpochMs`** owned by the hub; the hub flips desired to `stop` at the deadline.
- One **verb enum** used identically both directions; the hub **clamps `gainLinear` to a soft-cap** and **NACKs unknown verbs**.
- Routing key is the **stable `deviceId`**, not the friendly name.
- The service worker **passes media requests through with `Range`/206 preserved** (audio excluded from cache-first); assets are content-hash-versioned so a re-baked loop never serves stale. A 404/`stalled`/`error` on the audio element reports `state:'error'` so it can **never masquerade as "Playing."**

---

## 5. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Hub runtime | **Node.js LTS**, one process: `http` static + `ws` + `better-sqlite3` (WAL). One small Docker image. | Runs on the widest hardware (Pi armv7/arm64, NAS, Mac mini). Two deps, auditable. Bun is a fine arm64-only single-binary alt. |
| TLS / proxy | **Caddy 2**; primary Let's Encrypt **DNS-01 wildcard**; optional `*.ts.net`. | Auto-HTTPS, keeps `Range`/206, DNS-01 needs no device-side install. |
| LAN DNS | **dnsmasq** on the hub (or router static override). | Public hostname resolves to hub LAN IP offline; survives DHCP churn. |
| Overlay (optional) | **Tailscale + MagicDNS**, iOS 15+. | Off-LAN control / no-domain fallback. Demoted from hard dependency. |
| PWAs | **Vanilla HTML/CSS/JS**, hand-written service worker, shared protocol module. | Minimal memory footprint is a *survival* feature on 1 GB devices; small seam surface. |
| Noise pipeline | **ffmpeg** (+sox): crossfaded gapless loop, lossless WAV + HE-AAC + N loudness variants + `manifest.json`. | Offloads DSP; pre-baked loudness variants are the only safe "volume" knob on Tier-Legacy. |
| State | **SQLite (WAL)**, separate `desired`/`reported` per device; log2ram on Pi SD. | Durable across reboots; the split prevents resync-resurrects-noise. |
| Supervision | **Docker Compose `restart: unless-stopped`** (or systemd) for hub+Caddy+dnsmasq(+Tailscale), auto-start on boot. | Hub is a SPOF; unattended recovery after power blips is mandatory. |
| Liveness/alert | Hub 20–30 s ping/pong watchdog → `deviceOffline`; Controller **foreground Web Audio alarm + `navigator.vibrate`**; optional Web Push to the modern controller only. | Can't revive a suspended tab — detect fast + alert the awake phone. |

---

## 6. Proposed repo layout

```
/hub/            server.js  ws.js  state.js  db.js  monitor.js  push.js  Dockerfile
/shared/         protocol.(ts|js)   tiers.js
/web/player/     index.html  player.js  audio.js  sw.js  manifest.webmanifest
/web/controller/ index.html  controller.js  alarm.js  sw.js  manifest.webmanifest
/web/setup/      index.html  wizard.js
/pipeline/       bake.sh  loudness.md
/deploy/         docker-compose.yml  Caddyfile  dnsmasq.conf  install.sh  systemd/
/docs/           DESIGN.md  RECOVERY-CARD.md  HARDENING.md  OVERNIGHT-TEST.md
/test/           seam.test.js  protocol.test.js  soak/
```

Notable files: `state.js` holds the **hub-owned timer** that flips desired→stop at the deadline; `audio.js` keeps the **unrouted element as keep-alive** with the GainNode path optional; `sw.js` preserves `Range`/206; `seam.test.js` diffs controller command verbs ⇄ hub handlers ⇄ player handlers and asserts **zero mismatches** (per the project's seam rule).

---

## 7. Build plan (each milestone proves a real end-to-end capability)

- **M1 — Trusted HTTPS reaches a real old device (no per-device cert).** `docker compose up` provisions hub + Caddy DNS-01 wildcard + split-horizon dnsmasq; both PWA shells load over the padlock URL on an actual iOS 12–14 *and* a modern device; service worker registers. *Proves the foundation the naïve design hard-failed at.*
- **M2 — Audible seamless loop survives lock overnight on real hardware.** Bake the loop; arm one device with the **pure unrouted element** at calibrated volume; run the soak harness a full night on a Legacy *and* a Modern device. Deliverable: an honest continuity log (incl. first-eviction timestamp if any), interruption auto-resume after a test call, and the dark tap-anywhere `REQUIRES_GESTURE` screen after a forced reload. *Proves the make-or-break risk with data, sets the real tier boundaries.*
- **M3 — Full wire protocol: remote control + sleep-timer that never resurrects.** Shared protocol, hello handshake, desired/reported split, hub-owned absolute-deadline timer, snapshot-vs-command envelopes across all three layers. `seam.test` + `protocol.test` green. *Proves matched seams + a timer a reconnect can't undo.*
- **M4 — Parent-phone safety net.** Hub heartbeat/stale detection, ACK-within-3 s, loud Controller alarm + haptic, mandatory bedtime pre-flight, health banner (hub-down vs device-down vs Wi-Fi-down). *Proves the worst failure — invisible dead nursery speaker at 3 a.m. — becomes a pre-bed fixable signal.*
- **M5 — Tier-Modern full product + graceful degradation.** GainNode volume + fades, `audioSession` over-mute, MediaSession pause-intercept→re-play, Wake Lock, optional Tailscale + Web Push — all capability-gated; Legacy/Mid degrade to fixed-volume start/stop+timer with the Controller showing exactly which controls exist per device. *Proves full experience where supported + honest degradation, never a silent downgrade to a mystery on/off switch.*
- **M6 — One-time non-technical setup + multi-room + recovery.** Browser wizard (QR, test-tone calibration, hardening checklist, Shortcuts autostart), printed recovery card, manifest-driven soundscapes, two-parent/multi-device broadcast. *Proves a parent can set it up once across rooms and the system recovers or clearly alerts on every documented failure.*
- **M7 — "Send any audio" via HLS.** Hub packages arbitrary/long/live audio to HLS (ffmpeg); the player plays `.m3u8` through the same `<audio>` element (background-safe, same control plane). Foreground-only stream switching. *Proves the general "send audio to the iPad" goal beyond baked noise, reusing the reliable media path.* (see §12)
- **M8 — Live monitor / talk-to-room via WebRTC.** Hub acts as signaling; LAN P2P audio (one-way listen-in and two-way talk). Explicitly attended, not overnight. *Proves low-latency live audio without touching the hub protocol or the noise path.* (see §12)

### MVP cut
Single hub (Docker) + one Player PWA + Controller PWA, **always-audible model only**: HTTPS via DNS-01 + dnsmasq (no Tailscale); pure unrouted `<audio>` at a physically-calibrated volume + interruption auto-resume + dark tap-anywhere resume screen; hub-owned desired/reported state with absolute-deadline timer + snapshot resync; Controller does start/stop/set-timer + bedtime pre-flight + ACK-timeout alarm on the parent's phone; white/pink/brown loops with a soundscape switcher; and (capability-gated) GainNode remote volume + `audioSession` over-mute + MediaSession + Wake Lock on MODERN devices. An optional `MP_TOKEN` shared secret gates the control channel. **Omitted** (→ later): Tailscale overlay, Web Push, multi-room/two-parent broadcast, the polished install wizard/QR (MVP uses the CLI installer + typed URL). MVP deliberately does **not** promise remote cold-start-from-silence on old hardware.

---

## 8. Per-device setup UX (target: a non-technical parent, once)

1. **Admin, once (~10 min):** on the always-on box run the single installer (`docker compose up` / `./install.sh`). It provisions Caddy + split-horizon DNS, bakes the loops, prints the hub URL + QR. If you own a domain (recommended — covers *all* device ages), paste your DNS provider API token once for the DNS-01 wildcard; otherwise choose the Tailscale path (iOS 15+ only).
2. **Per device — open:** on the old iPhone/iPad, scan the room QR (or type the hub URL) in Safari. Confirm the padlock, no warning. No cert profile, no Tailscale on the DNS-01 path.
3. **Per device — harden (wizard-enforced):** disable Automatic Updates; Safari → *Close Tabs = Manually*; enable **Guided Access** (or Add-to-Home-Screen standalone on 15.4+) to block accidental pause; Low Power Mode off; plug into power on a hard, ventilated surface; ring switch **on** with ringer volume up (needed for audible playback below 16.4).
4. **Per device — arm + calibrate (the one mandatory tap):** name it ("Nursery"), tap **Arm this device**. This single gesture starts the pure looping noise element, wires MediaSession/`audioSession`/Wake Lock where available, and connects to the hub. A **test tone** plays — use the **physical volume buttons** to set a comfortable ceiling (this is the fixed volume on older devices; Modern devices also get on-screen volume/fades). **Confirm you hear it** before continuing.
5. **Per device — autostart + lock:** the wizard installs an **iOS Shortcut** ("when charging" / at a set time → open the hub URL) so a rebooted device reloads to a dark full-screen "tap anywhere to re-arm." Lock the device; it appears in the Controller with its **tier** shown.
6. **Bedtime pre-flight (nightly, ~5 s):** open the Controller, tap **Check all rooms** — it refuses green until every device ACKs. Fix any dark device *now*, awake, with lights on.
7. **Overnight test gate:** run one real overnight soak per device before relying on it unattended; only passing devices are marked safe.

---

## 9. Prior art (consider before building from scratch)

- **Snapcast + Snapweb** — its browser client already turns any browser tab into a **server-controlled, time-synced** audio renderer over WebSocket + Web Audio. The transport + multiroom sync is solved and battle-tested; the tab-must-stay-alive constraint is exactly the iOS problem above. **Strong fork/embed candidate.**
- **Home Assistant + Music Assistant 2.0** — already a remote-control plane; Music Assistant has a **Snapcast player provider**, and `browser_mod` can register a browser as a `media_player`. If you already run HA, "old phone as Snapcast client, controlled from HA" gets you most of the way; the only novel piece is a *reliable web-audio endpoint on old iOS*.
- **AirPlay (shairport-sync / OwnTone)** — wrong direction: these make a **Pi/PC a receiver for audio sent *from* Apple devices**. iOS devices are **AirPlay senders only** — you cannot AirPlay *to* an old iPad. Don't architect around it.
- **White-noise web apps** (myNoise, generative-noise PWAs) — good references for **procedural noise + gapless looping**, but they're foreground-first and hit the same background limits.

---

## 10. Safety note (infant white noise)

The app can only scale the **digital** signal, not guarantee acoustic SPL. Follow the 2014 *Pediatrics* infant-sleep-machine guidance: **low volume, place the device ≥ ~2 m / 7 ft from the child**, and use the sleep timer. The app should ship a **low default**, a **soft-cap/warning** at high settings, and in-app placement guidance.

---

## 11. Open questions (these change the design — see chat)

1. **Domain for Let's Encrypt DNS-01?** (the only zero-device-setup HTTPS path that works on iOS 12–14). If no, floor rises to iOS 15 (Tailscale).
2. **Exact device fleet** — models, iOS versions, RAM? Decides unattended-vs-attended and whether any are 1 GB (recommend excluding from unattended nursery use).
3. **Is "remotely start from silence at 3 a.m. on a locked device" a HARD requirement,** or is "audible all night at a set volume, adjustable on capable hardware" acceptable? Biggest scope driver.
4. **Hub hardware?** (Pi 4 / older NAS / Mac mini / spare laptop) — affects runtime + SD-longevity choices.
5. Rooms/devices count and number of parent controllers (multi-room, two-parent broadcast).
6. OK to require Guided Access / disabling auto-updates on nursery devices? (load-bearing for overnight survival).
7. How many soundscapes (white only, or white/pink/brown)? Multiple ⇒ pre-baked variants, effectively setup-time-only on old iOS.
8. Home internet reliability for cert renewal; and do you want **off-LAN** control (⇒ Tailscale becomes first-class)?

---

## 12. Audio delivery: baked loop vs HLS vs WebRTC

The white-noise core ships as a **pre-baked looping file** played through `<audio>`. But the broader goal ("send *any* audio to the device") and richer features (a live baby-monitor, casting the parent's current audio) point at two other delivery mechanisms. The important insight: **all three share the same control plane** (hub + wire protocol + tiers + parent-phone alarms) and, for the first two, the *same* `<audio>` element — they are delivery swaps, not re-architectures.

| Need | Mechanism | Background/lock survival | Latency | Notes |
|---|---|---|---|---|
| Unattended overnight white/pink/brown noise | **Baked loop file** via `<audio>` *(MVP)* | ✅ best (plain media element) | n/a | Lowest power, works fully offline, gapless via crossfade. Simplest = most reliable for the core job. |
| Your own uploaded audio (lullaby, recording) | **Uploaded file** via `<audio>` *(implemented)* | ✅ good (same media element path) | n/a | Controller uploads to the hub (`POST /api/upload`, ≤30 MB, audio types only); served from `/uploads/`, merged into `/api/library`, looped like the baked sounds. |
| Send arbitrary / long / library / live-from-hub audio, still background-safe | **HLS** via `<audio src=".m3u8">` | ✅ good (same media element path) | ~6 s (LL-HLS lower) | Native in Safari; inherits MediaSession + `audioSession` + lock survival for free. Hub packages/transcodes with ffmpeg (AAC segments). Not real-time. Overkill for stationary noise. |
| Live, low-latency: talk-to-room, listen-in (monitor), cast phone audio *now* | **WebRTC** (hub = signaling) | ⚠️ not designed for hours locked | <1 s | Real-time & two-way. iOS Safari supports it (getUserMedia + RTCPeerConnection); on-LAN needs no STUN/TURN. Power-hungry; treat as **attended**, not overnight. |

**HLS — when the goal grows past baked noise.** Because HLS plays through the very same `HTMLMediaElement` that already survives lock and drives the lock-screen controls, adding "play this arbitrary track / this long recording / this live hub feed on the Nursery speaker" is mostly a matter of pointing the player's `src` at an `.m3u8` the hub produces (ffmpeg → AAC segments + playlist). The control plane is unchanged: the Controller sends the same `setSoundscape`-style command with a stream id; the hub resolves it to an HLS URL. Caveats: (1) segment latency (~6 s; LL-HLS trims it but adds packaging complexity and uneven iOS support); (2) `<audio loop>` doesn't apply to a live stream — finite tracks need explicit end/replay handling; (3) **the src swap to an HLS stream must happen in the foreground** (mid-background src swaps are unsafe on iOS 15+, §1.3). Roadmap: **M7**.

**WebRTC — when you want to *hear into* or *talk into* the room live.** This is a genuinely different feature (baby monitor / intercom / instant cast), not a better way to play noise. The hub already runs a WebSocket, so it doubles as the signaling channel for SDP/ICE; on the home LAN, host/mDNS candidates connect directly with no STUN/TURN. The reason it is **not** for the overnight-noise path: a WebRTC remote track attached to `<audio>` has no guarantee of surviving hours on a locked old device (Safari may treat it like a call, and it is power-hungry). Keep it explicitly attended. Roadmap: **M8**.

Bottom line: **keep the baked loop for the always-on nursery job; add HLS for "send any audio"; add WebRTC for live monitor/talk.** None of them requires changing the hub, the wire protocol, the tier model, or the parent-phone safety net.
