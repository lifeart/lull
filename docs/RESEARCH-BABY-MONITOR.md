# mesh-playback — Baby-monitor ("radio-nanny") mode: feasibility report

> Output of an iOS-web / WebRTC feasibility exploration, cited to WebKit bug trackers and the W3C
> Audio Session API. "mic" = the nursery device's microphone. This is analysis for a future
> milestone (maps to DESIGN §12 / M8); nothing is implemented.

## 0. The make-or-break finding, stated first

**Concurrent playback + mic capture on one iOS device is possible — but it's a different audio session,
with real costs, and it is screen-on/foreground only.** The moment `getUserMedia({audio:true})`
succeeds, WebKit flips the OS audio session from `playback` to `playAndRecord` + voice processing.
Three verified consequences:

1. **The white-noise loop keeps playing, but its output changes**: measurably lower volume, possible
   re-route to the earpiece on iPhones (iPads have none), and mono/band-limited "call-quality"
   rendering, because output now passes through the Voice-Processing I/O unit. [WebKit bug 218012](https://bugs.webkit.org/show_bug.cgi?id=218012)
   — reported 2020, **still reproduces on iOS 18.6**. iOS 15.0–15.3 had a regression where the volume
   drop *persisted after capture stopped* until reload ([bug 230902](https://bugs.webkit.org/show_bug.cgi?id=230902); fixed 15.4).
2. **It does not kill the loop.** Playback + capture coexist in one page (the video-conference case the
   session API is designed for). `navigator.audioSession.type = 'play-and-record'` (iOS 16.4+ — the same
   feature-detect that already defines our MODERN tier) is the documented mitigation for the
   routing/volume chaos — set it *before* capture. On MID/LEGACY there is no session control at all.
3. **Screen lock ends it.** Mic capture is muted on lock (the track fires `mute` with no way to
   programmatically unmute — [webrtc/samples #1019](https://github.com/webrtc/samples/issues/1019),
   [bug 208516](https://bugs.webkit.org/show_bug.cgi?id=208516)). App-switch backgrounding is nuanced
   (WebKit keeps *audio* capture while muting *video* in some iOS 14.5+/15 configs), but **lock is not
   backgrounding**, behavior varies by build, and nothing documents guaranteed locked capture for a web
   page. Treat locked-device monitoring as **NO**, same class as "push can't start audio" (DESIGN §1.5).

**So "monitor mode" is a distinct, opt-in, screen-on device profile** (plugged in, Guided Access, dark
dimmed UI, Wake Lock where available) — it works *during* white-noise playback but changes the nursery
device's setup contract, which today ends with "lock the device" (DESIGN §8 step 5). The two profiles
conflict; pick per device, per night.

Also non-negotiable: **`getUserMedia` requires a secure context.** The plain-HTTP Synology path gets
**zero** monitor features — monitor mode raises the nursery device's floor to HTTPS.

## 1. Feasibility verdict matrix

| Capability | LEGACY (12–15.3, Safari tab) | MID (15.4–16.3) | MODERN (16.4+) | Locked screen |
|---|---|---|---|---|
| **Loudness/"cry" telemetry during playback** (AnalyserNode → number over existing WS) | experimental (no session control; 15.0–15.3 volume bug; exclude 1 GB) | attended, workable (screen on) | **reliable (screen-on)** — `play-and-record`, Wake Lock, re-calibrated volume | **NO** (mic mutes on lock) |
| **Listen-in during playback** (1-way WebRTC audio) | experimental (RTCPeerConnection since iOS 11, but session flakiness + RAM) | attended-only | **attended, solid** (+ duck-on-listen) | **NO** |
| **Two-way talk-to-room** | experimental | attended-only | attended, solid (AEC) | **NO** |
| **Video "peek at the room"** | experimental | attended, short bursts | attended, tap-to-peek 15–60 s | **NO — camera never survives background/lock, any iOS** |
| **Continuous overnight media on a locked device** | NO | NO | NO | NO |

"Attended" = nursery screen on and page foreground. Everything also requires HTTPS on the player.

## 2. Key answers

- **Concurrency corollaries:** (a) **never toggle capture mid-night** — the worst bugs are in start/stop
  cycles; acquire the mic once during the arm gesture and hold it. (b) **Calibrate volume with the mic
  already open** — `playAndRecord` changes the loop's loudness, so the test-tone calibration must run in
  monitor mode for monitor-profile devices. `playAndRecord`, like `playback`, ignores the ring/silent
  switch, so MODERN over-mute survives.
- **Background/lock:** the page JS stays alive on a locked device (the heartbeat/report design proves
  it) — that's not the constraint; the **capture interruption** is. Camera is stricter (muted on any
  backgrounding, every version). Foreground+screen-on: mic ✓ camera ✓. Locked: playback survives,
  capture doesn't → **monitor mode = screen stays on**.
- **Self-noise feedback:** better than intuition — iOS routes web capture through the Voice-Processing
  I/O unit whose AEC reference is the device's own output mix, i.e. it's built to subtract our white
  noise; steady broadband noise is the easy AEC case, and a loud non-stationary cry passes through at
  phone-call quality. Recommendation order: (1) **physically separate roles** (a second old device as a
  pure crib mic — zero self-noise, architecturally free); (2) same-device: **trust the voice pipeline +
  duck-on-listen** (MODERN `GainNode._rampGain` to ~20–30 %; MID/LEGACY temporary `element.volume`/pause
  as an ephemeral engine override that never touches `desired`); (3) don't bother with in-page spectral
  subtraction on 1 GB devices. Keep `echoCancellation`/`noiseSuppression` **on**.
- **Loudness/"cry" telemetry (the lightweight win, ship first):** an `AnalyserNode` on a
  `MediaStreamAudioSourceNode` (separate from the unrouted noise element) computes band-limited RMS
  (~300–3000 Hz) every second → one number added to the existing `makeReport`; controller renders a
  meter and reuses `alarm.js` for a sustained-spike alarm ("*possible* crying"). Avoids the whole WebRTC
  stack, ~4 bytes/s, stateless reconnects. **Does NOT avoid** the audio-session flip or the screen-on
  requirement (still calls gUM; mic still mutes on lock). Calibrate a per-device baseline at arm time.
- **WebRTC on old iOS + LAN:** getUserMedia + RTCPeerConnection since Safari 11/iOS 11; H.264 hardware
  from the start, Opus throughout — the whole fleet floor (iOS 12) is covered *in a Safari tab*
  (standalone-PWA gUM was broken pre-13.4 and permission isn't persisted — so monitor-profile devices
  run in a Safari tab). On the LAN, host/mDNS candidates connect directly, **no STUN/TURN** (only broken
  by AP client-isolation → "fix the AP" or add coturn on the hub later). **Signaling: a new message
  type `MSG.RTC` (`sub: offer|answer|ice|end`, `sessionId`, `target`), NOT a verb** — verbs feed
  `applyCommandToDesired` → persisted `desired` → replayed on every snapshot, so a mic session modeled
  as a verb would *silently resurrect a microphone* on reconnect (privacy + "never resurrect" violation).
  The hub relays opaquely (controller→player by `players.get(target)`; player→controller by a
  `sessionId → ws` map, cleaned in `_onClose`) and **never persists RTC state**. Telemetry needs no new
  envelope — one optional `micLevelDbfs` field on `REPORT`.
- **Video:** foreground-only, "tap to peek" only. 640×480 @ 10–15 fps H.264 ~250–500 kbps, 30–60 s
  bursts, hub-enforced one-session-per-device + auto-stop (thermal on old batteries). Dark nurseries
  defeat these old cameras (no IR). Continuous overnight video = **NO**.
- **Privacy:** media is DTLS-SRTP end-to-end; host-only candidates keep it on the LAN. Signaling rides
  the existing WSS (MP_TOKEN + Origin allowlist). **New exposure:** MP_TOKEN becomes a *live-microphone*
  credential → make monitor an opt-in toggle on the device at arm time, a persistent on-screen
  "monitoring" indicator (iOS 14+ orange mic dot helps), time-boxed ephemeral sessions.

## 3. Proposed architectures

- **A. Cry meter + attended intercom (recommended, same-device):** monitor is an arm-time opt-in
  profile; always-on loudness telemetry (M8a); on-demand attended listen/talk/video-peek (M8b/c). Fits
  the existing model: capability-gated via `detectCaps()`/`tierControls()` additions, failure detection
  stays on the parent's phone, hub stays a dumb relay.
- **B. Telemetry only (minimal):** ship M8a and stop. ~90 % of the value, ~10 % of the risk, works
  furthest down the tier ladder. Right scope for an iOS 12–15-era / 1 GB fleet.
- **C. Split roles (best audio, needs a 2nd device):** one device = noise speaker (unchanged, locked);
  a second near the crib = pure monitor (no playback → no self-noise, no session conflict). Same hub, a
  `role`/profile flag in `hello.caps`.

**Staged plan (M8 split):** **M8-S0** — a throwaway `/labs/` probe (loop + gUM + level meter) on the
*actual* fleet to measure the per-device volume shift/route/recovery first (DESIGN's own "prove the risk
with data" methodology). **M8a** telemetry (`micLevelDbfs` on `REPORT`, monitor opt-in,
`play-and-record` on MODERN, calibrate-with-mic-open, controller meter + spike alarm). **M8b** attended
listen (`MSG.RTC` signaling, one session/device, 60 s auto-end, duck-on-listen). **M8c** push-to-talk
(prime the talk `<audio>` element during arm) + tap-to-peek video with burst limits.

## 4. Honest limits — do not promise

1. **No monitoring of a locked or idle device. Ever.** (mic mutes on lock; camera dies on background —
   every iOS version). Same physics as "push can't start audio."
2. **No continuous overnight video.** Foreground-only, thermally unwise, blind in a dark room.
3. **Monitor mode changes the nursery device's contract:** screen on all night (light + battery + heat),
   Safari-tab operation, HTTPS-only, and slightly altered noise loudness while the mic is open.
4. **You won't hear the baby under full-volume noise** without ducking (MODERN) or a second device.
5. **New invariant if built:** monitor sessions are ephemeral and never enter `desired`/persisted state
   — a reconnect/snapshot must never silently reopen a mic; duck-for-listen is an engine-level override
   that can't survive a crash or mutate `desired.gainLinear`.

**Sources:** WebKit bugs [218012](https://bugs.webkit.org/show_bug.cgi?id=218012),
[230902](https://bugs.webkit.org/show_bug.cgi?id=230902),
[208516](https://bugs.webkit.org/show_bug.cgi?id=208516),
[185448](https://bugs.webkit.org/show_bug.cgi?id=185448),
[215884](https://bugs.webkit.org/show_bug.cgi?id=215884),
[179411](https://bugs.webkit.org/show_bug.cgi?id=179411) ·
[webrtc/samples #1019](https://github.com/webrtc/samples/issues/1019) ·
[W3C Audio Session API](https://www.w3.org/TR/audio-session/) ·
[WebKit WebRTC announcement](https://webkit.org/blog/7726/announcing-webrtc-and-media-capture/).
