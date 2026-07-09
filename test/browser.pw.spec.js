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
  await expect(card.locator('.lockline')).toContainText(/Keeps playing while locked/i);
  const slider = card.locator('input[type=range]');
  await expect(slider).toBeVisible(); // MID now has the foreground-volume fallback
  await expect(card.locator('.vol')).toContainText(/screen is on/i); // honest note
  await slider.evaluate((el) => { el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(card).toContainText('50%');
  await ctx.close();
});

test('sleep timer: hub-owned deadline stops the player on-device', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  const deviceId = await armPlayer(player, 'NurseryT');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryT' });
  await card.getByRole('button', { name: /Start|Playing/ }).click();
  await expect(player.locator('#stateLine')).toContainText('Playing', { timeout: 10000 });

  await nodeCommand(deviceId, { verb: VERBS.SET_TIMER, durationMs: 1500 });
  await expect(player.locator('#stateLine')).toContainText(/Silent/i, { timeout: 8000 });
  await expect(card.locator('.statechip')).toContainText('silent', { timeout: 8000 });
  await ctx.close();
});

test('offline device raises the alarm on the parent phone', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryO');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  await expect(controller.locator('.card', { hasText: 'NurseryO' })).toBeVisible({ timeout: 10000 });

  await player.close(); // device goes offline -> reconcileAlarms fires the alarm
  await expect(controller.locator('#alarmBanner')).toBeVisible({ timeout: 10000 });
  await expect(controller.locator('#alarmText')).toContainText('NurseryO');
  await controller.click('#alarmDismiss');
  await expect(controller.locator('#alarmBanner')).toBeHidden();
  await ctx.close();
});

test('soundscape switch changes what the player reports', async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await armPlayer(player, 'NurseryS');

  const controller = await ctx.newPage();
  await controller.goto('/controller/');
  const card = controller.locator('.card', { hasText: 'NurseryS' });
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

  const list = c.locator('#uploadList');
  const row = list.locator('.uprow', { hasText: 'ManageMe' });
  await expect(row).toBeVisible({ timeout: 10000 });

  // rename → BedtimeSong (unique)
  await row.getByRole('button', { name: 'Rename' }).click();
  await list.locator('input.upedit').fill('BedtimeSong');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(list.getByText('BedtimeSong', { exact: true })).toBeVisible({ timeout: 10000 });
  const card = c.locator('.card', { hasText: 'NurseryR' });
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
  const chips = card.locator('.sound .chips .chip');
  await expect(chips.first()).toHaveText('White noise'); // default order

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
  await controller.goto('/controller/');
  await expect(controller.locator('.card', { hasText: 'RoomOne' })).toBeVisible({ timeout: 10000 });
  await expect(controller.locator('.card', { hasText: 'RoomTwo' })).toBeVisible({ timeout: 10000 });

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
  await c.goto('/controller/');
  await expect(c.locator('.card', { hasText: 'RecoverRoom' })).toBeVisible({ timeout: 10000 });

  await p.close(); // offline → siren + banner
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
  await expect(local.locator('.local-state')).toHaveText('playing', { timeout: 10000 });
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
