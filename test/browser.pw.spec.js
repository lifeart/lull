// Real-browser end-to-end (drives the actual player.js + audio.js + controller.js + hub).
// Covers the paths the node/ws tests can't: real arming, the MODERN GainNode path, the
// hub-owned sleep timer stopping on-device, the parent-phone offline alarm, and soundscapes.

import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { makeHello, makeCommand, ROLES, VERBS } from '../shared/protocol.js';

const PORT = 8090;

async function armPlayer(page, name, { modern = false } = {}) {
  if (modern) {
    // Make detectCaps() see navigator.audioSession so the device reports MODERN.
    await page.addInitScript(() => {
      let t = 'auto';
      Object.defineProperty(navigator, 'audioSession', {
        configurable: true,
        get: () => ({ get type() { return t; }, set type(v) { t = v; } }),
      });
    });
  }
  await page.goto('/player/');
  await page.fill('#name', name);
  await page.click('#armBtn');
  await expect(page.locator('#stateLine')).toContainText(/armed & connected|Playing/i, { timeout: 10000 });
  return page.evaluate(() => localStorage.getItem('mp.deviceId'));
}

// Room cards render COLLAPSED by default (accordion); reveal a card's body before driving its
// controls. Expanding one collapses the others — fine, tests drive one card at a time.
async function expandCard(card) {
  if (await card.evaluate((el) => el.classList.contains('collapsed'))) {
    await card.locator('.cardhead .chev').click();
  }
  await expect(card).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
}

// The Manage/Sounds card is collapsed by default; open it before touching the library.
async function expandSounds(page) {
  const s = page.locator('#soundsCard');
  if (await s.evaluate((el) => el.classList.contains('collapsed'))) await s.locator('.cardhead .chev').click();
  await expect(s).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
}

// Capture every <audio> play() a controller page performs (the parent-phone alarm path): the
// muted/volume flags AND the src at the moment of play, so a test can decode the PCM and prove what
// would have been heard. Also records navigator.audioSession.type writes ('playback' is the
// over-the-iOS-mute-switch mode). Must run before any app code.
function captureAlarmAudio(page) {
  return page.addInitScript(() => {
    window.__plays = [];
    window.__sessionTypes = [];
    window.__audioEls = [];
    let sessionType = 'auto';
    try {
      Object.defineProperty(navigator, 'audioSession', {
        configurable: true,
        get: () => ({ get type() { return sessionType; }, set type(v) { sessionType = v; window.__sessionTypes.push(v); } }),
      });
    } catch (e) { /* some engines forbid redefining navigator props — the PCM checks still hold */ }
    window.Audio = function (src) {
      const el = {
        _src: src || '', loop: false, muted: false, volume: 1, currentTime: 0,
        setAttribute() {}, pause() {}, load() {},
        play() { window.__plays.push({ muted: this.muted, volume: this.volume, src: this._src }); return Promise.resolve(); },
        get src() { return this._src; }, set src(v) { this._src = v; },
      };
      window.__audioEls.push(el);
      return el;
    };
  });
}

// Whether every 16-bit PCM sample in a data:audio/wav;base64 URI is zero. Digital silence is the
// only thing the alarm prime may play — iOS ignores `volume` writes and can ignore `muted` on
// <audio>, so the muted/volume flags alone are no guarantee of silence.
function wavIsSilent(dataUri) {
  const buf = Buffer.from(String(dataUri).split(',')[1] || '', 'base64');
  for (let i = 44; i + 1 < buf.length; i += 2) if (buf.readInt16LE(i) !== 0) return false;
  return true;
}

// A throwaway controller over ws (Node side) to inject commands the UI can't (e.g. a short timer).
function nodeCommand(deviceId, fields) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on('open', () => {
      ws.send(JSON.stringify(makeHello({ role: ROLES.CONTROLLER, deviceId: 'pw-ctrl', friendlyName: 'pw', caps: {} })));
      ws.send(JSON.stringify(makeCommand({ target: deviceId, ...fields })));
      setTimeout(() => { ws.close(); resolve(); }, 300);
    });
    ws.on('error', reject);
  });
}

test('happy path: arm, start, stop, pre-flight (MID)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  const controller = await ctx.newPage();
  await armPlayer(player, 'Nursery');

  await controller.goto('/controller/');
  await expect(controller.locator('#hubStatus')).toContainText('hub connected', { timeout: 10000 });
  const card = controller.locator('.card', { hasText: 'Nursery' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);

  await card.getByRole('button', { name: /Start|Playing/ }).click();
  await expect(card.locator('.statechip')).toContainText('playing', { timeout: 10000 });
  await expect(player.locator('#stateLine')).toContainText('Playing', { timeout: 10000 });

  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card.locator('.statechip')).toContainText('silent', { timeout: 10000 });
  await expect(player.locator('#stateLine')).toContainText(/Silent/i, { timeout: 10000 });

  await controller.getByRole('button', { name: /Check all rooms/ }).click();
  await expect(controller.locator('#preflightResult')).toContainText(/responding/i, { timeout: 10000 });
  await ctx.close();
});

test('MODERN tier: volume slider drives SET_GAIN with no error', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryM', { modern: true });
  await expect(player.locator('#tierBadge')).toHaveText('MODERN');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryM' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await expect(card.locator('.lockline')).toContainText(/work while locked/i); // MODERN lock summary
  await card.getByRole('button', { name: /Start|Playing/ }).click();
  await expect(card.locator('.statechip')).toContainText('playing', { timeout: 10000 });

  const slider = card.locator('input[type=range]');
  await expect(slider).toBeVisible();
  await slider.evaluate((el) => {
    el.value = '0.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(card).toContainText('50%');
  await expect(card.locator('.statechip')).toContainText('playing'); // still playing, SET_GAIN didn't break it

  // Volume now reaches 100% (cap raised from 60% to full scale).
  await expect(slider).toHaveAttribute('max', '1');
  await slider.evaluate((el) => {
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(card).toContainText('100%');
  await ctx.close();
});

test('MID tier: per-device lock line + foreground volume slider', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryMid'); // headless Chromium detects as MID (no navigator.audioSession)
  await expect(player.locator('#tierBadge')).toHaveText('MID');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'NurseryMid' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await expect(card.locator('.lockline')).toContainText(/Keeps playing while locked/i);
  const slider = card.locator('input[type=range]');
  await expect(slider).toBeVisible(); // MID now has the foreground-volume fallback
  await expect(card.locator('.vol')).toContainText(/screen is on/i); // honest note
  await slider.evaluate((el) => { el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(card).toContainText('50%');
  await ctx.close();
});

test('MODERN taper: the wind-down checkbox drives SET_TAPER and persists in the hub state', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'TaperRoom', { modern: true });
  await expect(player.locator('#tierBadge')).toHaveText('MODERN');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  // Scope to the ONLINE card (ignore any offline ghosts a prior retry may have left).
  const card = controller.locator('.card:not(.offline)', { hasText: 'TaperRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);

  const taper = card.locator('input.taperbox');
  await expect(taper).toBeVisible(); // MODERN is the only tier that can fade in the audio thread while locked
  await expect(taper).not.toBeChecked();
  await taper.check();
  await expect(taper).toBeChecked();

  // Round-trip: a FRESH controller must see taper=true — proving it persisted in the HUB's desired
  // state (the same anti-drift guarantee as volume/soundscape), not just this tab's DOM.
  const c2 = await ctx.newPage();
  await c2.goto('/controller/');
  const card2 = c2.locator('.card:not(.offline)', { hasText: 'TaperRoom' });
  await expect(card2).toBeVisible({ timeout: 10000 });
  await expandCard(card2);
  await expect(card2.locator('input.taperbox')).toBeChecked({ timeout: 10000 });
  await ctx.close();
});

test('MID hides the wind-down control (honest tier gating); Airflow is a selectable sound', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'MidNoTaper'); // headless Chromium detects as MID (no navigator.audioSession)
  await expect(player.locator('#tierBadge')).toHaveText('MID');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card:not(.offline)', { hasText: 'MidNoTaper' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await expect(card.locator('input.taperbox')).toHaveCount(0); // no lock-surviving software fade → no control shown
  await expect(card.locator('.sound')).toContainText('Airflow'); // the new shaped masker shipped in the library
  await ctx.close();
});

test('sleep timer: hub-owned deadline stops the player on-device', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  const deviceId = await armPlayer(player, 'NurseryT');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryT' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await card.getByRole('button', { name: /Start|Playing/ }).click();
  await expect(player.locator('#stateLine')).toContainText('Playing', { timeout: 10000 });

  await nodeCommand(deviceId, { verb: VERBS.SET_TIMER, durationMs: 1500 });
  await expect(player.locator('#stateLine')).toContainText(/Silent/i, { timeout: 8000 });
  await expect(card.locator('.statechip')).toContainText('silent', { timeout: 8000 });
  await ctx.close();
});

test('offline device raises the alarm on the parent phone (when the drop alarm is enabled)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryO');

  const controller = await ctx.newPage();
  await controller.addInitScript(() => localStorage.setItem('mp.alarmDrop', '1')); // opt in (off by default)
  await captureAlarmAudio(controller); // prove the siren is AUDIBLE, not just the banner
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryO' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await card.getByRole('button', { name: /Start|Playing/ }).click(); // must be PLAYING for a drop to alarm
  await expect(card.locator('.statechip')).toContainText('playing', { timeout: 10000 });

  await player.close(); // a PLAYING device goes offline -> reconcileAlarms fires the alarm
  await expect(controller.locator('#alarmBanner')).toBeVisible({ timeout: 10000 });
  await expect(controller.locator('#alarmText')).toContainText('NurseryO');
  // The <audio> siren really sounded: an unmuted full-volume play of the REAL tone (not the silent
  // unlock src the prime uses), with the over-the-iOS-mute-switch 'playback' session armed.
  const { plays, sessions } = await controller.evaluate(() => ({ plays: window.__plays, sessions: window.__sessionTypes }));
  const audible = plays.filter((p) => !p.muted && p.volume === 1);
  expect(audible.length).toBeGreaterThanOrEqual(1);
  for (const p of audible) expect(wavIsSilent(p.src)).toBe(false);
  expect(sessions).toContain('playback');
  await controller.click('#alarmDismiss');
  await expect(controller.locator('#alarmBanner')).toBeHidden();
  await ctx.close();
});

test('room drop does NOT alarm by default (opt-in only)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'QuietDrop');

  const controller = await ctx.newPage();
  await controller.goto('/controller/'); // no mp.alarmDrop set → default OFF
  const card = controller.locator('.card', { hasText: 'QuietDrop' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await card.getByRole('button', { name: /Start|Playing/ }).click(); // even PLAYING, default-off ⇒ no alarm
  await expect(card.locator('.statechip')).toContainText('playing', { timeout: 10000 });

  await player.close(); // goes offline
  await expect(card).toContainText(/offline/i, { timeout: 10000 }); // the drop DID propagate to the card…
  await expect(controller.locator('#alarmBanner')).toBeHidden(); // …but no siren fires by default
  await ctx.close();
});

test('enabled but a SILENT room dropping does not alarm (only playing rooms)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'SilentDrop'); // armed but never started → stays silent/STOPPED

  const controller = await ctx.newPage();
  await controller.addInitScript(() => localStorage.setItem('mp.alarmDrop', '1')); // alarm ON…
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'SilentDrop' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);

  await player.close(); // a SILENT room goes offline
  await expect(card).toContainText(/offline/i, { timeout: 10000 }); // …the drop propagated…
  await expect(controller.locator('#alarmBanner')).toBeHidden(); // …but no alarm: it wasn't playing
  await ctx.close();
});

test('loading the controller with an already-offline room does not alarm (even when enabled)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'GhostReload');
  await player.close(); // it's offline in the hub registry BEFORE the controller ever connects

  const controller = await ctx.newPage();
  await controller.addInitScript(() => localStorage.setItem('mp.alarmDrop', '1')); // enabled — still must not fire on load
  await controller.goto('/controller/');
  await expect(controller.locator('.card', { hasText: 'GhostReload' })).toBeVisible({ timeout: 10000 });
  await controller.waitForTimeout(1500); // give any (wrong) alarm a chance to appear
  await expect(controller.locator('#alarmBanner')).toBeHidden(); // seeded offline on WELCOME → no transition → no siren
  await ctx.close();
});

// A room that is CONNECTED but not answering (an iPad whose tab went to sleep): picking a sound for
// it must NOT blast the siren — the parent is right there looking at the phone; the banner is
// enough. Only a failed START intent is siren-worthy (the parent believes the room is covering the
// baby and it isn't). (user: "I open the app at night, pick a sound and the siren goes off")
test('unresponsive room: a failed sound pick shows the banner WITHOUT the siren; a failed start still sirens', async ({ browser }) => {
  const ctx = await browser.newContext();
  // A protocol-level player that never ACKs any command (the ws lib still answers keepalive pings,
  // so the hub keeps it "online" — exactly like a suspended-but-connected device).
  const mute = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((res, rej) => { mute.on('open', res); mute.on('error', rej); });
  mute.send(JSON.stringify(makeHello({ role: ROLES.PLAYER, deviceId: 'pw-mute-room', friendlyName: 'MuteRoom', caps: {} })));

  const controller = await ctx.newPage();
  await controller.addInitScript(() => localStorage.setItem('mp.alarmDrop', '1')); // even opted-in, a sound pick stays quiet
  await captureAlarmAudio(controller);
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'MuteRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await card.locator('.sound .chips button').first().click(); // SET_SOUNDSCAPE → no ACK → 3s timeout
  await expect(controller.locator('#alarmBanner')).toBeVisible({ timeout: 10000 });
  await expect(controller.locator('#alarmText')).toContainText('no response');
  const quiet = await controller.evaluate(() => window.__plays.filter((p) => !p.muted).length);
  expect(quiet).toBe(0); // banner only — nothing audible was played

  // The same dead room failing a START is the real emergency — the siren still fires.
  await card.getByRole('button', { name: 'Start' }).click();
  await expect.poll(
    () => controller.evaluate(() => window.__plays.filter((p) => !p.muted && p.volume === 1).length),
    { timeout: 10000 },
  ).toBeGreaterThanOrEqual(1);
  mute.close();
  await ctx.close();
});

test('the first tap (on the "This device" header) primes the alarm with digital SILENCE, never audibly', async ({ browser }) => {
  // The alarm <audio> is unlocked on the first interaction — for the reporting user, tapping the
  // "This device" card header right after opening the app. The prime must be inaudible EVERYWHERE:
  // iOS ignores `volume` writes and can ignore `muted` on <audio>, so a muted play() of the siren
  // tone can still blip (user: "I hear the alarm when I click the This-device header after app
  // start"). Guarantee: every play() at prime is all-zero PCM (plus muted + volume 0 as a belt),
  // and the app does NOT arm the over-the-mute-switch 'playback' session until a real alarm fires.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await captureAlarmAudio(page);
  await page.goto('/controller/');
  const head = page.locator('#localPlayer .cardhead');
  await head.waitFor(); // the card renders once the sound library loads
  await head.locator('strong').click(); // the user's exact repro: the FIRST tap is the card title
  await expect(page.locator('#localPlayer')).toHaveClass(/(^|\s)collapsed(\s|$)/); // the tap only toggled the accordion
  await page.waitForTimeout(300); // let the prime's play() promise settle
  const { plays, sessions, els } = await page.evaluate(() => ({
    plays: window.__plays, sessions: window.__sessionTypes,
    els: window.__audioEls.map((e) => ({ src: e.src, muted: e.muted })),
  }));
  expect(plays.length).toBeGreaterThanOrEqual(1); // the prime did run
  for (const p of plays) {
    expect(p.muted && p.volume === 0).toBeTruthy(); // belt: silenced where muted/volume are honored…
    expect(wavIsSilent(p.src)).toBe(true); // …and the samples themselves are pure silence everywhere
  }
  expect(sessions).not.toContain('playback'); // no over-the-mute-switch session armed just by opening
  // After the unlock the element must hold the REAL tone (still muted, never played) so a genuine
  // alarm can sound later without a fresh gesture. Other Audio constructions exist (detectCaps()
  // probes element volume with src-less throwaways) — the alarm element is the one with a WAV src.
  const alarmEls = els.filter((e) => String(e.src).indexOf('data:audio/wav') === 0);
  expect(alarmEls.length).toBe(1);
  expect(wavIsSilent(alarmEls[0].src)).toBe(false);
  expect(alarmEls[0].muted).toBe(true);
  await ctx.close();
});

test('cards form an accordion: rooms + Sounds collapsed, "This device" open; one at a time', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'AccordionRoom');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const room = c.locator('.card', { hasText: 'AccordionRoom' });
  await expect(room).toBeVisible({ timeout: 10000 });
  // Defaults: room collapsed, local "This device" expanded, Manage/Sounds collapsed.
  await expect(room).toHaveClass(/(^|\s)collapsed(\s|$)/);
  await expect(c.locator('#localPlayer')).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
  await expect(c.locator('#soundsCard')).toHaveClass(/(^|\s)collapsed(\s|$)/);
  // Expanding the room collapses "This device" (one open at a time).
  await room.locator('.cardhead .chev').click();
  await expect(room).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
  await expect(c.locator('#localPlayer')).toHaveClass(/(^|\s)collapsed(\s|$)/);
  // Sounds is independent — opening it does NOT collapse the room.
  await c.locator('#soundsCard .cardhead .chev').click();
  await expect(c.locator('#soundsCard')).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
  await expect(room).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
  await ctx.close();
});

test('soundscape switch changes what the player reports', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryS');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryS' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await card.getByRole('button', { name: /Start|Playing/ }).click();
  await expect(player.locator('#stateLine')).toContainText('Playing', { timeout: 10000 });

  await card.getByRole('button', { name: /Pink/ }).click();
  await expect(player.locator('#soundLine')).toContainText(/pink/i, { timeout: 8000 });
  await ctx.close();
});

test('upload audio: it appears as a sound and plays on the device', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  const deviceId = await armPlayer(player, 'NurseryU');

  // Upload a real (decodable) WAV via the file input; it should become a sound chip.
  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryU' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  const wav = readFileSync('web/player/assets/white.wav');
  await controller.locator('#fileInput').setInputFiles({ name: 'Nap.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(controller.locator('#uploadStatus')).toContainText(/Added/i, { timeout: 15000 });
  await expect(card.getByRole('button', { name: 'Nap', exact: true })).toBeVisible({ timeout: 10000 });

  // Foreground the player, then start + switch to the uploaded track (no background-deferral race).
  await player.bringToFront();
  const upId = await player.evaluate(async () => (await (await fetch('/api/library')).json()).soundscapes.find((s) => s.kind === 'upload')?.id);
  await nodeCommand(deviceId, { verb: VERBS.START });
  await nodeCommand(deviceId, { verb: VERBS.SET_SOUNDSCAPE, soundscape: upId });
  await expect(player.locator('#soundLine')).toContainText(/Nap/i, { timeout: 10000 }); // reports the label
  await ctx.close();
});

test('manage uploads: rename then delete', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryR');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const wav = readFileSync('web/player/assets/white.wav');
  await c.locator('#fileInput').setInputFiles({ name: 'ManageMe.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(c.locator('#uploadStatus')).toContainText(/Added/i, { timeout: 15000 });

  await expandSounds(c);
  const list = c.locator('#uploadList');
  const row = list.locator('.uprow', { hasText: 'ManageMe' });
  await expect(row).toBeVisible({ timeout: 10000 });

  // rename → BedtimeSong (unique)
  await row.getByRole('button', { name: 'Rename' }).click();
  await list.locator('input.upedit').fill('BedtimeSong');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(list.getByText('BedtimeSong', { exact: true })).toBeVisible({ timeout: 10000 });
  const card = c.locator('.card', { hasText: 'NurseryR' });
  await expandCard(card);
  await expect(card.getByRole('button', { name: 'BedtimeSong', exact: true })).toBeVisible({ timeout: 10000 });

  // delete (two-tap confirm)
  const brow = list.locator('.uprow', { hasText: 'BedtimeSong' });
  await brow.getByRole('button', { name: 'Delete' }).click();
  await brow.getByRole('button', { name: 'Confirm?' }).click();
  await expect(list.getByText('BedtimeSong', { exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect(card.getByRole('button', { name: 'BedtimeSong', exact: true })).toHaveCount(0, { timeout: 10000 });
  await ctx.close();
});

test('drag-to-reorder sounds updates the chip order on device cards', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryOrd');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'NurseryOrd' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  const chips = card.locator('.sound .chips .chip');
  await expect(chips.first()).toHaveText('White noise'); // default order

  await expandSounds(c);
  const list = c.locator('#uploadList');
  await list.scrollIntoViewIfNeeded(); // the local-player card makes the page taller than the viewport
  const brownHandle = list.locator('.uprow', { hasText: 'Brown noise' }).locator('.handle');
  const firstRow = list.locator('.uprow').first();
  const bh = await brownHandle.boundingBox();
  const fb = await firstRow.boundingBox();
  await c.mouse.move(bh.x + bh.width / 2, bh.y + bh.height / 2);
  await c.mouse.down();
  await c.mouse.move(fb.x + fb.width / 2, fb.y - 4, { steps: 10 });
  await c.mouse.up();

  // full baked order propagated (not just the first row), catching a scrambled tail
  const names = list.locator('.uprow .upname');
  await expect(names.nth(0)).toHaveText('Brown noise', { timeout: 10000 });
  await expect(names.nth(1)).toHaveText('White noise');
  await expect(names.nth(2)).toHaveText('Pink noise');
  await expect(chips.nth(0)).toHaveText('Brown noise', { timeout: 10000 });
  await expect(chips.nth(1)).toHaveText('White noise');
  await expect(chips.nth(2)).toHaveText('Pink noise');
  await ctx.close();
});

test('arrow reorder: the ▲▼ buttons move a library row and the card chips (bug: arrows not working)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'ArrowRoom');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'ArrowRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await expandSounds(c);
  const list = c.locator('#uploadList');
  await list.scrollIntoViewIfNeeded();
  const names = list.locator('.uprow .upname');
  await expect(names.nth(0)).toBeVisible({ timeout: 10000 });

  // Robust to whatever order prior tests left: take the 2nd row, tap its ▲, assert it swapped up.
  const before = await names.allTextContents();
  const first = before[0], second = before[1];
  await list.locator('.uprow', { hasText: second }).getByRole('button', { name: new RegExp(`Move ${second} up`, 'i') }).click();
  await expect(names.nth(0)).toHaveText(second, { timeout: 10000 });
  await expect(names.nth(1)).toHaveText(first, { timeout: 10000 });
  // the new top sound is first among the card's sound chips too
  await expect(card.locator('.sound .chips .chip').nth(0)).toHaveText(second, { timeout: 10000 });
  await ctx.close();
});

test('library refresh self-heals: an upload done while a delete is armed still appears (bug fix)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'DeferRoom');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  await expect(c.locator('.card', { hasText: 'DeferRoom' })).toBeVisible({ timeout: 10000 });
  await expandSounds(c);
  const list = c.locator('#uploadList');
  const wav = readFileSync('web/player/assets/white.wav');

  await c.locator('#fileInput').setInputFiles({ name: 'FirstUp.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(list.getByText('FirstUp', { exact: true })).toBeVisible({ timeout: 15000 });
  // Arm delete on it (sets the library "busy" flag) but do NOT confirm.
  await list.locator('.uprow', { hasText: 'FirstUp' }).getByRole('button', { name: 'Delete' }).click();
  await expect(list.locator('.uprow', { hasText: 'FirstUp' }).getByRole('button', { name: 'Confirm?' })).toBeVisible();
  // Upload a second while the delete is armed — before the fix this stayed deferred forever.
  await c.locator('#fileInput').setInputFiles({ name: 'SecondUp.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(c.locator('#uploadStatus')).toContainText(/Added/i, { timeout: 15000 });
  // It appears on its own once the interaction releases (self-heal + flush-on-disarm) — no extra tap.
  await expect(list.getByText('SecondUp', { exact: true })).toBeVisible({ timeout: 12000 });
  await ctx.close();
});

test('favorite a sound: the star pins it to the top of the library and the card chips', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryFav');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'NurseryFav' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await expandSounds(c);
  const list = c.locator('#uploadList');
  const pinkStar = () => list.locator('.uprow', { hasText: 'Pink noise' }).locator('.fav');
  await expect(pinkStar()).toBeVisible({ timeout: 10000 });

  await pinkStar().click(); // favorite Pink noise
  await expect(list.locator('.uprow .upname').nth(0)).toHaveText('Pink noise', { timeout: 10000 });
  await expect(card.locator('.sound .chips .chip').nth(0)).toHaveText('Pink noise', { timeout: 10000 });
  // active state fully reflected: filled-star icon (solid path) + .on class + aria-pressed
  await expect(pinkStar().locator('path[fill="currentColor"]')).toHaveCount(1, { timeout: 10000 });
  await expect(pinkStar()).toHaveClass(/\bon\b/);
  await expect(pinkStar()).toHaveAttribute('aria-pressed', 'true');

  await pinkStar().click(); // un-favorite → the pin + active state are released
  await expect(pinkStar().locator('path[fill="currentColor"]')).toHaveCount(0, { timeout: 10000 }); // outline star
  await expect(pinkStar()).not.toHaveClass(/\bon\b/);
  await expect(pinkStar()).toHaveAttribute('aria-pressed', 'false');
  await ctx.close();
});

test('inline ＋ chip opens the picker and adds a sound to the card', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryPlus');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'NurseryPlus' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  const wav = readFileSync('web/player/assets/white.wav');
  const [chooser] = await Promise.all([
    c.waitForEvent('filechooser'),
    card.getByRole('button', { name: 'Add a sound' }).click(),
  ]);
  await chooser.setFiles({ name: 'Chime.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(card.getByRole('button', { name: 'Chime', exact: true })).toBeVisible({ timeout: 15000 });
  await ctx.close();
});

test('multi-device: two rooms appear; closing one alarms only it by name', async ({ browser }) => {
  // Separate contexts = isolated localStorage = two genuinely distinct devices (one context would
  // share mp.deviceId/mp.name and collapse them into one).
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const ctxC = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  await armPlayer(p1, 'RoomOne');
  await armPlayer(p2, 'RoomTwo');

  const controller = await ctxC.newPage();
  await controller.addInitScript(() => localStorage.setItem('mp.alarmDrop', '1')); // opt into the drop alarm
  await controller.goto('/controller/');
  await expect(controller.locator('.card', { hasText: 'RoomOne' })).toBeVisible({ timeout: 10000 });
  const cardTwo = controller.locator('.card', { hasText: 'RoomTwo' });
  await expect(cardTwo).toBeVisible({ timeout: 10000 });
  await expandCard(cardTwo);
  await cardTwo.getByRole('button', { name: /Start|Playing/ }).click(); // playing → its drop will alarm
  await expect(cardTwo.locator('.statechip')).toContainText('playing', { timeout: 10000 });

  await p2.close();
  await expect(controller.locator('#alarmText')).toContainText('RoomTwo', { timeout: 10000 });
  await ctx1.close(); await ctx2.close(); await ctxC.close();
});

test('forget: an offline (ghost) device can be removed from the controller (finding #3)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'GhostRoom');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'GhostRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  const forget = card.locator('.forget');
  // Forget is offered only once the device is offline.
  await expect(forget).toBeHidden();

  await player.close(); // device goes offline → becomes a ghost
  await expect(forget).toBeVisible({ timeout: 10000 });
  await forget.click();                       // two-tap confirm
  await expect(forget).toHaveText(/Confirm/i);
  await forget.click();                       // confirm → hub drops the registration
  await expect(card).toHaveCount(0, { timeout: 10000 }); // card disappears
  await ctx.close();
});

test('baby monitor: the mic loudness meter appears on the controller when monitoring (M8a)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'MonitorRoom');

  // Turn on the baby monitor (fake mic auto-granted via the launch flags).
  const toggle = player.locator('#monitorToggle');
  await expect(toggle).toBeVisible({ timeout: 10000 });
  await toggle.click();
  await expect(toggle).toContainText(/on/i, { timeout: 10000 });

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'MonitorRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  // The room-sound meter shows once the device reports a mic level.
  await expect(card.locator('.mic')).toBeVisible({ timeout: 10000 });
  await ctx.close();
});

test('pre-arm hardening checklist persists across a reload (P9)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/player/');
  const list = p.locator('#hardenList');
  await expect(list.locator('.checkrow')).toHaveCount(6, { timeout: 10000 });
  await expect(p.locator('#hardenCount')).toHaveText('0/6');
  await list.locator('.harden[data-key="power"]').check();
  await list.locator('.harden[data-key="ring"]').check();
  await expect(p.locator('#hardenCount')).toHaveText('2/6');
  await p.reload(); // persisted per device
  await expect(p.locator('#hardenCount')).toHaveText('2/6', { timeout: 10000 });
  await expect(p.locator('.harden[data-key="power"]')).toBeChecked();
  await ctx.close();
});

test('add-a-room link prefills the name so the device needs no typing (P4)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  await c.locator('#addRoomBtn').click();
  await c.locator('#addRoomName').fill('Nursery');
  const href = await c.locator('#addRoomLink').getAttribute('href');
  expect(href).toMatch(/\/player\/\?name=Nursery/);

  // Opening that link prefills the name → boots straight to "Tap to arm Nursery" (P8), no typing.
  const p = await ctx.newPage();
  await p.goto(href);
  await expect(p.locator('#overlayText')).toContainText('Nursery', { timeout: 10000 });
  await expect(p.locator('#setup')).toBeHidden();
  await ctx.close();
});

test('ambient health: the controller auto-verifies rooms with no manual check (P3)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'HealthRoom');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  await expect(c.locator('.card', { hasText: 'HealthRoom' })).toBeVisible({ timeout: 10000 });
  // The health line auto-populates (no "Check all rooms" tap) once the auto-probe resolves.
  // (Exact wording depends on whether other rooms are online — a shared-hub test may see ghosts.)
  await expect(c.locator('#healthLine')).toContainText(/verified|not responding/i, { timeout: 10000 });
  await ctx.close();
});

test('alarm auto-de-escalates once the room recovers (P5)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await armPlayer(p, 'RecoverRoom');

  const c = await ctx.newPage();
  await c.addInitScript(() => localStorage.setItem('mp.alarmDrop', '1')); // opt into the drop alarm
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'RecoverRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  await card.getByRole('button', { name: /Start|Playing/ }).click(); // playing → its drop alarms
  await expect(card.locator('.statechip')).toContainText('playing', { timeout: 10000 });

  await p.close(); // a PLAYING room goes offline → siren + banner
  await expect(c.locator('#alarmText')).toContainText('RecoverRoom', { timeout: 10000 });

  // Bring the SAME device back (same context → same deviceId) and re-arm via the tap-to-arm overlay.
  const p2 = await ctx.newPage();
  await p2.goto('/player/');
  await p2.locator('#overlay').click();
  await expect(p2.locator('#status')).toBeVisible({ timeout: 10000 });

  // The banner demotes to a passive "recovered" note (siren silenced).
  await expect(c.locator('#alarmText')).toContainText(/recovered/i, { timeout: 10000 });
  await ctx.close();
});

test('fast re-arm: a returning device boots to a big "tap to arm", not the form (P8)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await armPlayer(p, 'ReturnRoom'); // persists mp.name + mp.deviceId in this context
  await p.reload();

  // Returning, un-armed: the setup form is skipped for a big dark tap-to-arm overlay.
  await expect(p.locator('#overlay')).toHaveClass(/show/, { timeout: 10000 });
  await expect(p.locator('#overlayText')).toContainText(/Tap to arm/i);
  await expect(p.locator('#overlayText')).toContainText('ReturnRoom');
  await expect(p.locator('#setup')).toBeHidden();

  await p.locator('#overlay').click(); // one tap re-arms — no typing
  await expect(p.locator('#status')).toBeVisible({ timeout: 10000 });
  await expect(p.locator('#stateLine')).toContainText(/armed & connected|Playing/i, { timeout: 10000 });
  await ctx.close();
});

test('local playback: the main app plays sound on THIS device with no speaker client', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/'); // no player device armed at all
  const local = c.locator('#localPlayer');
  await expect(local.locator('.local-play')).toHaveText(/Play here/i, { timeout: 10000 });

  // One tap arms + plays locally.
  await local.locator('.local-play').click();
  await expect(local.locator('.local-eq')).toBeVisible({ timeout: 10000 }); // playing → eq bars (the "playing" text is dropped as redundant)
  await expect(local.locator('.local-play')).toHaveText(/Pause/i);
  await expect(local.locator('.local-eq')).toBeVisible();

  // Switch sound locally, then a local sleep timer starts a countdown.
  await local.locator('.local-sounds').getByRole('button', { name: 'Pink noise' }).click();
  await expect(local.locator('.local-sounds').getByRole('button', { name: 'Pink noise' })).toHaveAttribute('aria-pressed', 'true');
  await local.locator('.local-timers').getByRole('button', { name: '15m' }).click();
  await expect(local.locator('.local-rem')).toHaveText(/1[45]:\d\d/, { timeout: 10000 });

  // Pause stops it.
  await local.locator('.local-play').click();
  await expect(local.locator('.local-state')).toHaveText('stopped', { timeout: 10000 });
  await ctx.close();
});

test('default-ON sleep timer: a plain Start applies ~45 min; an explicit "off" is honored', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'DefaultTimerRoom');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'DefaultTimerRoom' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  const rem = card.locator('.rem');

  // Never chose a timer → 45m is pre-selected and a plain Start applies a ~45:00 countdown.
  await expect(card.getByRole('button', { name: '45m' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: /Start/ }).click();
  await expect(rem).toHaveText(/4[45]:\d\d/, { timeout: 10000 });

  // Explicitly turn the timer OFF → remembered as off, and a later plain Start has NO countdown.
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(rem).toHaveText('—', { timeout: 10000 });
  await card.getByRole('button', { name: 'off' }).click();
  await expect(card.getByRole('button', { name: 'off' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: /Start/ }).click();
  await expect(rem).toHaveText('—', { timeout: 10000 });
  await ctx.close();
});

test('remembered per-room sleep timer: Start re-applies the last-chosen timer (P1)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryTimer');

  const c = await ctx.newPage();
  await c.goto('/controller/');
  const card = c.locator('.card', { hasText: 'NurseryTimer' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expandCard(card);
  const rem = card.locator('.rem');

  // Pick 15m → the device starts with a ~15:00 timer, and the chip is remembered (pressed).
  await card.getByRole('button', { name: '15m' }).click();
  await expect(rem).toHaveText(/1[45]:\d\d/, { timeout: 10000 });
  await expect(card.getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');

  // Stop wipes the timer…
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(rem).toHaveText('—', { timeout: 10000 });

  // …but a plain Start re-applies the remembered 15m — the P1 win.
  await card.getByRole('button', { name: /Start/ }).click();
  await expect(rem).toHaveText(/1[45]:\d\d/, { timeout: 10000 });
  await ctx.close();
});

test('Bedtime scene: one tap starts every online room (P2)', async ({ browser }) => {
  // Separate contexts = separate localStorage = two genuinely distinct online devices.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await armPlayer(a, 'BedRoomA');
  await armPlayer(b, 'BedRoomB');

  const c = await ctxC.newPage();
  await c.goto('/controller/');
  await expect(c.locator('.card', { hasText: 'BedRoomA' })).toBeVisible({ timeout: 10000 });
  await expect(c.locator('.card', { hasText: 'BedRoomB' })).toBeVisible({ timeout: 10000 });

  await c.getByRole('button', { name: /Start bedtime/ }).click();
  await expect(a.locator('#stateLine')).toContainText('Playing', { timeout: 10000 });
  await expect(b.locator('#stateLine')).toContainText('Playing', { timeout: 10000 });
  await expect(c.locator('#preflightResult')).toContainText(/Started/i, { timeout: 10000 });
  await ctxA.close(); await ctxB.close(); await ctxC.close();
});

test('local player remembers the last selected sound across a reload', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  const sounds = c.locator('#localPlayer .local-sounds');
  const brown = sounds.getByRole('button', { name: 'Brown noise' });
  await expect(brown).toBeVisible({ timeout: 10000 });
  // Pick a non-default sound (default is pink), then reload the controller.
  await brown.click();
  await expect(brown).toHaveAttribute('aria-pressed', 'true');
  await c.reload();
  // The choice persists (localStorage) instead of snapping back to the default.
  await expect(c.locator('#localPlayer .local-sounds').getByRole('button', { name: 'Brown noise' }))
    .toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
  await ctx.close();
});

test('loader: "Play here" shows a spinner until the sound is ready (not-instant start ≠ broken)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  // Make the audio asset observably slow so the fetch+decode window is real, not a race.
  await c.route('**/*.wav', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
  await c.goto('/controller/');
  const local = c.locator('#localPlayer');
  await expect(local.locator('.local-play')).toHaveText(/Play here/i, { timeout: 10000 });

  await local.locator('.local-play').click();
  // Immediately: a visible spinner + "starting…" so the tap never looks ignored (the whole point).
  await expect(local.locator('.local-state .spinner')).toBeVisible({ timeout: 2000 });
  await expect(local.locator('.local-state')).toContainText(/starting/i);
  await expect(local.locator('.local-play')).toContainText(/Starting/i);

  // Then it resolves to playing and the spinner is gone.
  await expect(local.locator('.local-eq')).toBeVisible({ timeout: 10000 }); // playing → eq bars (the "playing" text is dropped as redundant)
  await expect(local.locator('.local-state .spinner')).toHaveCount(0);
  await expect(local.locator('.local-play')).toHaveText(/Pause/i);
  await ctx.close();
});

test('offline: a cached sound plays with no network (Cache Storage / airplane mode)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  // Wait for the service worker to install, activate, and control this page.
  await c.waitForFunction(() => navigator.serviceWorker && !!navigator.serviceWorker.controller, null, { timeout: 20000 });

  // Play the default sound once online so it's in the audio cache (install also pre-caches it).
  const local = c.locator('#localPlayer');
  await expect(local.locator('.local-play')).toHaveText(/Play here/i, { timeout: 10000 });
  await local.locator('.local-play').click();
  await expect(local.locator('.local-eq')).toBeVisible({ timeout: 10000 }); // playing → eq bars (the "playing" text is dropped as redundant)
  await local.locator('.local-play').click(); // pause
  await expect(local.locator('.local-state')).toHaveText('stopped', { timeout: 10000 });

  // The loop is now in Cache Storage under the shared audio cache.
  const cached = await c.evaluate(() =>
    caches.open('mp-audio-v1').then((cache) => cache.match('/player/assets/pink.wav')).then((r) => !!r));
  expect(cached).toBe(true);

  // Go fully offline and reload — the shell rehydrates from cache…
  await ctx.setOffline(true);
  await c.reload();
  await c.waitForFunction(() => navigator.serviceWorker && !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  const local2 = c.locator('#localPlayer');
  await expect(local2.locator('.local-play')).toHaveText(/Play here/i, { timeout: 10000 });

  // …and playback works with NO network — the buffer decodes from the cached loop.
  await local2.locator('.local-play').click();
  await expect(local2.locator('.local-eq')).toBeVisible({ timeout: 10000 }); // plays offline → eq bars
  await ctx.close();
});

test('double-tap zoom is disabled app-wide (touch-action: manipulation)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  const ta = await c.evaluate(() => getComputedStyle(document.body).touchAction);
  expect(ta).toBe('manipulation');
  await ctx.close();
});

test('add-room form: defaults to Bedroom, carries the token, disables + hides the preview when empty', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/#t=house-token'); // controller has a token
  await c.locator('#addRoomBtn').click();
  const name = c.locator('#addRoomName'), token = c.locator('#addRoomToken');
  const link = c.locator('#addRoomLink'), copy = c.locator('#addRoomCopy');

  // Default name is "Bedroom"; the token is prefilled from the controller's own.
  await expect(name).toHaveValue('Bedroom');
  await expect(token).toHaveValue('house-token');
  // The link preview shows and carries name + token; the add button is enabled.
  await expect(link).toBeVisible();
  await expect(link).toHaveText(/\/player\/\?name=Bedroom.*#t=house-token/);
  await expect(copy).toBeEnabled();

  // Clearing the name disables the button and hides the link preview.
  await name.fill('');
  await expect(copy).toBeDisabled();
  await expect(link).toBeHidden();

  // A different token flows into the generated link.
  await name.fill('Nursery');
  await token.fill('other-family');
  await expect(link).toHaveText(/name=Nursery.*#t=other-family/);
  await expect(copy).toBeEnabled();
  await ctx.close();
});

test('this device: the card header keeps the same height when playback starts (title stays one line)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  const head = c.locator('#localPlayer .cardhead');
  const play = c.locator('#localPlayer .local-play');
  await expect(play).toHaveText(/Play here/i, { timeout: 10000 });
  const stoppedH = await head.evaluate((el) => el.offsetHeight);

  await play.click();
  await expect(c.locator('#localPlayer .local-eq')).toBeVisible({ timeout: 10000 }); // playing → eq bars showing
  await expect(c.locator('#localPlayer .local-state')).toBeHidden(); // redundant "playing" text is dropped
  const playingH = await head.evaluate((el) => el.offsetHeight);
  expect(playingH).toBe(stoppedH); // no jump — the title didn't wrap to a second line
  await ctx.close();
});

test('installed PWA declares fullscreen display in both manifests', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  const m = await c.evaluate(async () => ({
    player: await (await fetch('/player/manifest.webmanifest')).json(),
    controller: await (await fetch('/controller/manifest.webmanifest')).json(),
  }));
  expect(m.player.display).toBe('fullscreen');
  expect(m.player.display_override).toContain('fullscreen');
  expect(m.controller.display).toBe('fullscreen');
  await ctx.close();
});

test('dim: controller dims to black with a faint alive indicator, restores on tap', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  const dim = c.locator('#dimOverlay');
  await expect(dim).toBeHidden();
  await c.locator('#dimBtn').click();
  await expect(dim).toBeVisible();
  await expect(c.locator('#dimOverlay .dim-dot')).toBeVisible(); // minor feedback: the breathing dot
  const bg = await dim.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(0, 0, 0)'); // truly black
  await dim.click(); // tap anywhere restores
  await expect(dim).toBeHidden();
  await ctx.close();
});

test('dim: player dims with a faint per-room state line; tap restores', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/player/');
  await p.fill('#name', 'Nursery');
  await p.click('#armBtn');
  await p.locator('#status').waitFor({ state: 'visible', timeout: 10000 });
  const dim = p.locator('#dimOverlay');
  await expect(dim).toBeHidden();
  await p.locator('#dimBtn').click();
  await expect(dim).toBeVisible();
  await expect(p.locator('#dimText')).toContainText('Nursery'); // faint alive indicator names the room + state
  await dim.click();
  await expect(dim).toBeHidden();
  await ctx.close();
});

test('dim keeps audio ACTUALLY running (AudioContext stays "running" while the screen is black)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  // Instrument the real AudioContext so the test can read its live state.
  await c.addInitScript(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const Wrapped = function (...a) { const inst = new AC(...a); window.__lastAC = inst; return inst; };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
  });
  await c.goto('/controller/');
  const local = c.locator('#localPlayer');
  await local.locator('.local-play').click();
  await expect(local.locator('.local-eq')).toBeVisible({ timeout: 10000 }); // playing

  const state = () => c.evaluate(() => (window.__lastAC ? window.__lastAC.state : 'no-ctx'));
  expect(await state()).toBe('running'); // audio flowing before dim

  await c.locator('#dimBtn').click();
  await expect(c.locator('#dimOverlay')).toBeVisible();
  await c.waitForTimeout(1500);
  expect(await state()).toBe('running'); // ...and STILL flowing with the screen fully black

  await c.locator('#dimOverlay').click(); // tap restores
  await expect(c.locator('#dimOverlay')).toBeHidden();
  await expect(local.locator('.local-eq')).toBeVisible();
  await expect(local.locator('.local-play')).toContainText(/Pause/i);
  expect(await state()).toBe('running');
  await ctx.close();
});

test('service worker version is auto-injected as a content hash (no manual bump)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto('/controller/');
  const sw = await c.evaluate(async () => ({
    controller: await (await fetch('/controller/sw.js')).text(),
    player: await (await fetch('/player/sw.js')).text(),
  }));
  // The literal marker must have been replaced by the hub with a real hash.
  expect(sw.controller).not.toContain('__SHELL_VER__');
  expect(sw.player).not.toContain('__SHELL_VER__');
  const cm = sw.controller.match(/mp-controller-shell-([a-f0-9]{12})/);
  const pm = sw.player.match(/mp-player-shell-([a-f0-9]{12})/);
  expect(cm).toBeTruthy();
  expect(pm).toBeTruthy();
  expect(cm[1]).toBe(pm[1]); // same content hash of web/ + shared/ across both SWs
  await ctx.close();
});
