# Changelog

All notable changes to mesh-playback. See [`docs/HANDOFF.md`](docs/HANDOFF.md) for the full,
current picture and [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture and iOS constraints.

## [0.1.0] — Production-hardened MVP

Remote white-noise control for old iPhones/iPads on the home LAN, in web tech only: a tiny Node
hub (one dep, `ws`) serving a Player PWA and a Controller PWA that share one wire protocol.
**83 node tests + 12 real-browser Playwright tests, all green.** Container deploy path verified
end-to-end (build, non-root boot, serve + Range/206, fail-closed auth, graceful-shutdown flush,
volume persistence and root-owned-volume upgrade). Real-iOS overnight soak is the remaining unknown.

### Core capability
- Arm-once flow; remote start/stop; hub-owned absolute-deadline sleep timer that never resurrects
  noise across a reconnect; per-device persisted volume; white/pink/brown + uploaded sounds
  (add/rename/delete/reorder); MediaSession / Wake Lock / `audioSession`, all feature-gated.
- Capability tiers (LEGACY / MID / MODERN), feature-detected, never version-sniffed; each device
  states honestly what works while locked.
- Reliability lives on the parent's phone: ACK-within-3s, bedtime pre-flight, loud over-mute alarm
  + haptic on command failure and on spontaneous device failure.

### Review rounds
- **Rounds 1–4** — adversarial hardening of the MVP (27 → 32 → 13 → 5 findings, all fixed).
- **Round 5 — production-readiness audit (21 findings, all fixed):**
  - Hub can no longer be crashed by a malformed (`null`/array/number) WebSocket frame; added an
    `uncaughtException` handler and per-socket message rate limiting.
  - A device can no longer report **PLAYING while silent**: liveness is re-verified before every
    report and on element `pause` / AudioContext `statechange`; a start-intent command only ACKs
    success once audio truly reaches PLAYING; `recover()` clears a stuck "needs a tap".
  - Alarm trust: the ERROR alarm is edge-triggered (dismissable); the offline alarm seeds a silent
    baseline on reconnect so a hub restart can't storm every room; the parent alarm plays through an
    `<audio>` element via `audioSession='playback'` to sound over the iOS silent switch.
  - Ghost devices: a parent-facing **Forget** control + `/api/device/forget`, plus boot-time
    eviction of devices unseen past `MP_DEVICE_TTL_DAYS` (default 45).
  - Security/ops: Origin (CSRF) gating on the state-changing `/api` routes; the hub **fails closed**
    without `MP_TOKEN` on a non-loopback host (override with `MP_ALLOW_OPEN=1`); uploads stream to a
    temp file with a size cap + concurrency limit; boot-time `/data` writability probe; `/healthz`
    reports online/offline counts + `persistHealthy` (503 on write failure); graceful shutdown
    flushes pending state to disk.
  - Deploy/PWA/a11y: container runs as the unprivileged `node` user via a `su-exec` entrypoint that
    keeps a pre-existing root-owned volume writable across the upgrade; `HEALTHCHECK` added; Caddy
    defaults to `tls internal` (HTTPS on first boot) with the zero-device-install DNS-01 upgrade
    documented; service-worker cache cleanup scoped per app; ≥44px hit areas, WCAG-AA contrast, and
    a keyboard reorder path.
- **Round-5 self-review** — a second adversarial pass over the round-5 edits caught and fixed 4
  regressions in the fixes themselves (rate-limit cap below the pre-flight fan-out; start-intent ACK
  keyed on the wrong verb; an alarm/prime race; the non-root switch vs a pre-existing root-owned
  volume).

### Demo
- **GitHub Pages demo** — the unmodified Player + Controller PWAs run server-lessly against an
  in-browser mock hub (`demo/mock-hub.js`): `window.WebSocket`/`fetch` are patched and a single
  hub is elected across tabs/iframes via the Web Locks API, relaying over `BroadcastChannel` and
  running the real `shared/protocol.js` reducers. `pipeline/build-demo.js` assembles `_site/`
  (relative paths, injected mock, SW disabled) and `.github/workflows/pages.yml` deploys it.
  Verified end-to-end (arm → start/stop → pre-flight → offline alarm, both as two tabs and as the
  iframe landing).
