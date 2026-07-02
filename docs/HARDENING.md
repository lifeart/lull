# Per-device iOS hardening (do this once on each nursery device)

These steps are load-bearing for overnight survival — skipping them drops the reliability tier.

- **Plug into power.** On a hard, ventilated surface (not a bed/couch — heat build-up).
- **Settings → General → Software Update → Automatic Updates → OFF.** An overnight OS update reboots the device and stops the sound.
- **Settings → Safari → Tabs → Close Tabs → Manually.** Otherwise Safari discards the tab.
- **Add to Home Screen** (iOS 15.4+) and launch from that icon, OR enable **Guided Access**
  (Settings → Accessibility → Guided Access) to stop accidental Control-Center pause.
- **Low Power Mode → OFF** (it throttles background work harder).
- **Ring/silent switch ON with ringer volume up** on iOS < 16.4 (needed for audible playback;
  16.4+ plays over the mute switch via audioSession).
- **Screen brightness low**, then lock. The audio keeps the tab resident.
- Set the volume with the **physical volume buttons** during arm/calibration — on LEGACY/MID
  devices that is the only volume control (iOS ignores software volume there).
- Optional: an **iOS Shortcut** "When charging → Open URL (hub)" so a rebooted device reloads
  to the tap-to-arm screen.

Then run the [overnight test](OVERNIGHT-TEST.md) before relying on the device unattended.
