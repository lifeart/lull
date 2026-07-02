# Overnight test gate (run once per device before trusting it unattended)

Background-audio **continuity** — not sync — is the make-or-break risk on old iOS. Measure it
before you rely on a device for a sleeping child.

## Procedure
1. Harden the device ([HARDENING.md](HARDENING.md)) and **Arm** it. Confirm you hear noise.
2. Start playback from the Controller with **no sleep timer** (or a long one).
3. Lock the device, leave it plugged in overnight (8h).
4. In the morning, **without unlocking**, confirm the noise is still playing.
5. Open the Controller: the device should still be "playing" and respond to Stop/Start.

## Pass / fail
- **PASS:** audio audible all night AND the device still responds. Mark it safe for unattended use.
- **PARTIAL:** audio played but the device went unresponsive (tab reclaimed). Usable only
  *attended*, and rely on the Controller alarm. Common on 1 GB / iOS 12–14 hardware.
- **FAIL:** audio stopped during the night. Do not use unattended. Try: keep it plugged, lower
  memory use (close other apps), use a newer device for the nursery, or a different iOS build.

## What to watch
- iOS **memory pressure** can reclaim the tab (→ white reload → audio re-locked → needs a tap).
- **OS updates** (should be disabled) and **incoming calls/alarms** interrupt audio; the app
  auto-resumes on foreground, but a locked device may need a tap.
- Record the device model + iOS build with the result; behavior varies by point release.
