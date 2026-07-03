# mesh-playback — Handoff

Everything a new contributor (or a future session) needs to pick this up. Written 2026-07-02.

## 1. What it is
Turn **old iPhones/iPads on the home LAN into remotely-controlled speakers**, in **web tech only**
(no per-iOS-version native builds). Primary use: **start/stop/adjust white noise for a child from
your own phone.** Three parts:
- **Hub** — a tiny always-on Node process (one dep: `ws`) serving two PWAs over HTTPS + a WebSocket
  relay + per-device state + the sound library.
- **Player PWA** (`/player/`) — runs on each old device; the "speaker".
- **Controller PWA** (`/controller/`) — runs on the parent's phone; the remote.

Full rationale + the verified iOS constraints are in [`DESIGN.md`](DESIGN.md). Read §1–§2 first.

## 2. Status
**MVP complete, tested, and hardened through five adversarial review rounds** (27 → 32 → 13 → 5 →
a 21-finding production-readiness audit, all fixed). ~2,700 LOC. **80 node tests + 12 real-browser
Playwright tests, all green.** The container deploy path is verified end-to-end (builds, boots as a
non-root user, serves both PWAs + Range/206, fail-closed auth, graceful-shutdown state flush,
volume persistence across restart). Not yet run on real iOS hardware end-to-end — see the honest
limits (§7) and the overnight-test gate.

**Round 5 (production hardening) — what changed, by area:**
- **Hub crash-proofing:** non-object WS frames (a bare `null`) can no longer crash the process;
  added `uncaughtException` handler + per-socket try/catch + a token-bucket message rate limit.
- **Never-false-playing (the core promise):** the player now re-verifies liveness before every
  report and on `pause`/AudioContext `statechange`, so an OS interruption that pauses audio with no
  visibility event can't keep a locked device reporting PLAYING while the room is silent. A
  start-intent command only ACKs success if audio actually reached PLAYING. `recover()` clears a
  stuck REQUIRES_GESTURE once audio flows again (no false 3am alarm while playing).
- **Alarm trust:** ERROR alarm is edge-triggered (dismissable); the offline alarm seeds a silent
  baseline on each WELCOME so a hub restart can't storm every room; the parent alarm now also plays
  through an `<audio>` element routed via `audioSession='playback'` to sound over the iOS silent switch.
- **Ghost devices:** a parent-facing **Forget** button on offline cards + `/api/device/forget`, plus
  boot-time eviction of devices unseen past `MP_DEVICE_TTL_DAYS` (default 45) — so the bedtime
  pre-flight can recover and the 64-device cap can't fill.
- **Security/ops:** state-changing `/api` routes now enforce the same Origin allowlist as the WS
  (CSRF); the hub **fails closed** without `MP_TOKEN` on a non-loopback host; uploads stream to a
  temp file with a size cap + concurrency limit; boot-time writability probe on `/data`; `/healthz`
  reports online/offline counts + `persistHealthy` (503 if writes fail); graceful shutdown flushes
  pending state to disk.
- **Deploy:** the app process runs as the unprivileged `node` user via a `su-exec` entrypoint that
  first fixes `/data` ownership as root (so a **pre-existing root-owned volume from an older deploy
  stays writable across the upgrade** — a fresh volume only inherits image-dir ownership); added a
  `HEALTHCHECK`. Caddyfile defaults to `tls internal` (HTTPS on first boot) with the DNS-01
  zero-device-install upgrade documented; Caddy uses `depends_on: service_started` so a hub outage
  can't also take down TLS. **PWA:** service-worker cache cleanup is scoped per-app (no more wiping
  the other app's offline shell); shell bumped to v3. **A11y:** ≥44px hit areas, WCAG-AA `--faint`,
  keyboard reorder buttons, labelled rename input.
- **Round-5 self-review** (a second adversarial pass over the round-5 edits) caught and fixed 4
  regressions in the fixes themselves: the new rate-limit cap was below the pre-flight fan-out
  (would reap the controller mid-check), the start-intent ACK keyed on the reduced verb (NACKed a
  routine volume nudge and re-alarmed), an alarm/prime race could mute the first alarm, and the
  non-root switch broke writes to a pre-existing root-owned volume. All verified fixed.

## 3. Run / test / deploy
```bash
npm install                       # one runtime dep: ws
npm run bake                      # generate seamless white/pink/brown loops + PNG icons
npm start                         # hub on http://localhost:8080  (localhost is a secure context)
npm test                          # 83 node tests
npx playwright install chromium   # once
npm run test:e2e                  # 12 real-browser tests
```
- **Dev:** open `http://localhost:8080/controller/` and `/player/` in two tabs.
- **Real device:** needs HTTPS (service worker / audioSession / wake lock require a secure context).
  Deploy behind **Caddy + Let's Encrypt DNS-01 + split-horizon DNS** — see [`deploy/`](../deploy) and
  DESIGN §1.6. Then harden each device ([`HARDENING.md`](HARDENING.md)) and run the
  [overnight test](OVERNIGHT-TEST.md) before trusting it unattended.
- **Env:** `PORT`, `HOST`, `STATE_FILE`, `UPLOADS_DIR` (resolved to absolute — keep it that way),
  `MP_DOMAIN`/`MP_ORIGIN` (WS + `/api` Origin allowlist), `MP_TOKEN` (shared secret gating the
  control channel — **required on a non-loopback host** unless `MP_ALLOW_OPEN=1`),
  `MP_DEVICE_TTL_DAYS` (ghost-device eviction age, default 45; 0 disables).

## 4. Architecture map
```
shared/protocol.js   THE wire contract — verbs, message builders, validators, the shared reducer
                     (applyCommandToDesired / reduceCommand), tier helpers (usesGain, foregroundVolume,
                     probeAudibleReady), timer reconcile. Imported by hub AND both PWAs. Single source.
shared/tiers.js      detectCaps() (feature+element.volume probe), tierControls(tier,caps), lockSummary(tier)

hub/server.js        HTTP (static, Range-safe) + WS upgrade + /api routes; env; auth wiring
hub/ws.js            connection registry, heartbeat reaper, message routing, broadcasts, self-player intent
hub/state.js         desired/reported store API + HUB-OWNED sleep timer (absolute deadline, chunked)
hub/store.js         atomic JSON persistence (poison-proof write chain)
hub/auth.js          Origin allowlist + optional MP_TOKEN (pure/testable: makeVerifyClient)
hub/uploads.js       user audio library: add/rename/remove + order (index.json)
hub/static.js        traversal-safe file server with Range/206 (serveStatic, serveFileWithin)

web/app.css          Apple HIG design system: system colors/fills, 8-pt spacing, light/dark, [hidden] fix
web/player/          index.html, player.js (arm/WS/recovery), audio.js (the iOS audio engine), sw.js
web/controller/      index.html, controller.js (cards/commands/alarm/library/reorder), alarm.js, sw.js
web/index.html       landing tiles

pipeline/bake.js     zero-dep seamless-loop WAV generator (+ calls icon.js)
pipeline/icon.js     zero-dep PNG app-icon generator (blue tile + white glyph)
deploy/              Dockerfile (non-root via su-exec entrypoint + HEALTHCHECK), docker-compose.yml
                     (hub + Caddy), docker-compose.synology.yml (hub-only for a NAS), Caddyfile,
                     entrypoint.sh, dnsmasq, install.sh
docs/                DESIGN.md, HANDOFF.md (this), HARDENING.md, RECOVERY-CARD.md, OVERNIGHT-TEST.md,
                     DEPLOY-SYNOLOGY.md (NAS: plain-HTTP vs DSM-HTTPS, TLS trade-offs),
                     RESEARCH-AMBIENT-SOUNDS.md (licensed sound sourcing + auto-download + favorites),
                     RESEARCH-BABY-MONITOR.md (radio-nanny / mic-monitor feasibility, M8)
demo/                mock-hub.js (in-browser hub) + index.html; built by pipeline/build-demo.js →
                     _site/, deployed by .github/workflows/pages.yml
```

### Secure context / TLS (what actually needs HTTPS)
The core — looping `<audio>` that survives lock in a Safari **tab**, WebSocket control, the sleep
timer, and the parent-phone alarm — **works over plain `http://` on the LAN** (e.g. a Synology at
`http://<nas-ip>:8080`). HTTPS (a secure context) is required only for the **MODERN** tier extras:
`audioSession` (remote GainNode volume/fades + over-mute), Wake Lock, service worker / installable
PWA. On plain HTTP every device caps at tier **MID/LEGACY** and the app degrades cleanly (all APIs are
feature-detected). The hub accepts **same-origin** requests (Origin host == the Host you connect to),
so LAN-IP / NAS-hostname / Host-preserving-proxy access needs **no `MP_ORIGIN`**. Full guidance +
the easy DSM Let's-Encrypt path: [`DEPLOY-SYNOLOGY.md`](DEPLOY-SYNOLOGY.md).

### The seam rule (important)
Every layer speaks the SAME verbs/units from `shared/protocol.js` — **never hard-code a verb/state
string.** `test/seam.test.js` enforces this (fails on raw verb literals; derives the valid set from
`VERBS`). Units are baked into field names (`gainLinear`, `endsAtEpochMs`, `remainingSec`).

### Wire protocol (one-liner)
Controller/self-player → `command` (verb + fields, needs ACK) → hub reduces onto per-device
**desired**, relays to the player → player realizes audio, ACKs, and sends **reported** telemetry.
Hub sends an authoritative **snapshot** (replace-all) on every (re)connect. `library` broadcast tells
clients to refetch `/api/library`. Full shapes in DESIGN §4.

## 5. Capability tiers (feature-detected, never version-sniffed)
- **MODERN** (has `navigator.audioSession`, ~iOS 16.4+): GainNode remote volume + fades, over-mute
  playback, best-effort remote-start/volume while locked.
- **MID** (has mediaSession, no audioSession; iOS 15.4–16.3 **or** desktop/Android): background audio
  + MediaSession; **foreground volume via `element.volume` only where honored** (probe: old iOS ignores
  it → no slider, falls back to hardware-fixed).
- **LEGACY** (neither): always-audible loop, fixed volume, start/stop + timer only.

Each device shows an honest 🔒 `lockSummary(tier)` line stating what works while locked.

## 6. Key invariants (don't regress these)
- **Sound = one looping `<audio>` element.** Only that survives screen lock; raw Web Audio dies.
  MODERN routes it through a GainNode (background survival then relies on `audioSession='playback'`,
  best-effort); LEGACY/MID stay UNROUTED.
- **Never resurrect noise:** a STOPPED device stays silent — sleep timer is an absolute
  `endsAtEpochMs` owned by the hub, reconciled on every snapshot; `_swapSoundscape(…, shouldPlay)`
  won't play a stopped device; auto-replay handlers gate on `shouldSound()`.
- **Never a false "playing":** if audio can't reach a running state, the player reports
  `REQUIRES_GESTURE`/`ERROR` and shows a dark tap-to-resume overlay; the controller alarms the parent.
- **Failure detection lives on the parent's phone** (ACK-within-3s + bedtime pre-flight + loud alarm),
  because a suspended nursery tab can't be revived remotely.
- **No silent error swallowing** (project rule): catches show UI feedback or log; `apiPost` surfaces
  failures in `#uploadStatus`.
- **Absolute base dirs** for file serving — a relative `UPLOADS_DIR` 403s every file (fixed; keep
  `path.resolve`).

## 7. Honest limitations (state these to the user; don't paper over)
- **Cannot guarantee "start noise from silence on a locked OLD device at 3am."** iOS can reclaim the
  backgrounded tab overnight; after any reload audio is re-locked and needs a physical tap (Web Push
  cannot start audio). Mitigation = tiered model + parent-phone alarm, not a guarantee.
- **MODERN "works while locked" is best-effort** — GainNode routing can be suspended on lock; `recover()`
  downgrades to "needs tap" if the context can't resume.
- **MID foreground volume is a no-op on real old iOS** (element.volume ignored) — which is why the
  slider is hidden there via the `caps.elementVolume` probe.
- **Verified in headless Chromium only.** Real-device background/overnight behavior is unproven — that's
  what `OVERNIGHT-TEST.md` is for.

## 8. What's done
Arm-once flow; start/stop; hub-owned sleep timer; per-device (persisted) volume; white/pink/brown +
**uploaded** sounds (add via ＋/drag-drop, rename, delete, drag-to-reorder); MediaSession/Wake Lock/
audioSession (feature-gated); reconnect + full-state resync; heartbeat reaping; bedtime pre-flight +
spontaneous-failure alarm; now-playing waveform; Apple-HIG light/dark UI; MP_TOKEN auth; Caddy/DNS-01
deploy; comprehensive node + Playwright tests.

## 9. Suggested next steps
- **Real-device overnight test** (the make-or-break unknown) — set the true tier boundaries. The
  container deploy path itself is now verified (build/boot/serve/persist/shutdown); what remains
  unproven is on-device background/lock behavior over a real night.
- **Expand the sound library** — CC0/PD ambient loops (rain/ocean/forest/fireplace/stream/wind) +
  favorites. Full sourcing/licensing research + a concrete auto-download-once and hub-synced-favorites
  design is in [`RESEARCH-AMBIENT-SOUNDS.md`](RESEARCH-AMBIENT-SOUNDS.md) (favorites reuse `MSG.LIBRARY`;
  no protocol change).
- **Baby-monitor (radio-nanny) mode** — mic loudness "cry meter" (ships first) → attended WebRTC
  listen/talk → video peek. Feasibility + the hard iOS limits (screen-on only, never on a locked device)
  in [`RESEARCH-BABY-MONITOR.md`](RESEARCH-BABY-MONITOR.md) (maps to M8).
- **HLS delivery** (send any/long/live audio, same background-safe media path) — DESIGN §12, milestone M7.
- **WebRTC** live "talk to / listen into the room" (attended) — DESIGN §12, M8.
- Optional polish: install wizard (QR + test-tone calibration), Web Push liveness to the controller,
  multi-room/two-parent broadcast, per-soundscape MediaSession metadata.

## 10. Gotchas for the next editor
- `node --test` uses **process isolation** per file — that's how `test/hub-auth.test.js` gets a fresh
  `MP_TOKEN` server while `test/uploads.test.js` runs token-less.
- Playwright shares ONE hub across tests; `test/pw.global-setup.js` wipes `data/e2e-*` per run. Use
  **unique device/sound names per test** and scope locators to avoid cross-test ambiguity.
- Client modules import `/shared/…` (absolute in the browser); `audio.js` uses a `../../shared/…`
  relative path so it's Node-unit-testable. `player.js`/`controller.js` aren't Node-importable (DOM at
  load) — that's why player command handling is tested via the shared `reduceCommand`.
- Baked WAVs + PNG icons are **git-ignored and regenerated** by `npm run bake`.
