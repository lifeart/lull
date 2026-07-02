// Heartbeat reaper white-box test (finding: the only mechanism that detects a frozen iOS tab
// had no coverage). Uses a fake ws so we can step ticks deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../hub/ws.js';

const fakeStore = { list: () => [], get: () => null };
function mkFakeWs() {
  return {
    _meta: { role: 'player', deviceId: 'x', alive: true },
    readyState: 1, // OPEN
    pings: 0, terminated: false, sent: [],
    ping() { this.pings++; },
    terminate() { this.terminated = true; },
    send(s) { this.sent.push(s); },
    on() {},
  };
}

test('heartbeat pings, survives on pong, and reaps a socket that misses a pong', () => {
  const hub = new Hub(fakeStore);
  const ws = mkFakeWs();
  hub.players.set('x', ws);

  hub._heartbeatTick(); // t1: alive true -> false, ping
  assert.equal(ws._meta.alive, false);
  assert.equal(ws.pings, 1);
  assert.equal(ws.terminated, false);

  ws._meta.alive = true; // simulate a pong arriving
  hub._heartbeatTick(); // t2: ponged -> survives, ping again
  assert.equal(ws.pings, 2);
  assert.equal(ws.terminated, false);

  hub._heartbeatTick(); // t3: no pong since t2 -> reap
  assert.equal(ws.terminated, true);
  hub.stop();
});

test('_onClose removes a player from the registry', () => {
  const hub = new Hub(fakeStore);
  const ws = mkFakeWs();
  hub.players.set('x', ws);
  hub._onClose(ws);
  assert.equal(hub.players.has('x'), false);
  hub.stop();
});
