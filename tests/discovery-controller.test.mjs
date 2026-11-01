import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryController } from '../src/lib/discovery/controller.ts';
import { bindDiscoveryLifecycle } from '../src/lib/discovery/browser-lifecycle.ts';

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const row = {
  id: '9f0c663b-8ffd-4e13-92d9-2b68572c08b1', name: '<img src=x>', conflict: false,
  candidates: [{ name: '<img src=x>', baseUrl: 'http://192.168.50.10:8080', joinable: true, unavailableReason: null, sources: [] }],
};

test('a selected row is only a selector and loses currency on removal, pause or a new session', async () => {
  const f = fixture();
  f.setSnapshot({ status: 'searching', rows: [row] });
  f.controller.start();
  await flush();
  const selected = f.controller.select(row.id, row.candidates[0].baseUrl);
  assert.equal(f.controller.isSelectionCurrent(selected), true);
  assert.equal(f.controller.select('unknown', row.candidates[0].baseUrl), null);
  f.setSnapshot({ status: 'searching', rows: [] });
  await f.advance(1000);
  assert.equal(f.controller.isSelectionCurrent(selected), false);
  f.setSnapshot({ status: 'searching', rows: [row] });
  await f.advance(1000);
  f.controller.retry();
  await flush();
  assert.equal(f.controller.isSelectionCurrent(selected), false);
  const next = f.controller.select(row.id, row.candidates[0].baseUrl);
  assert.notEqual(next.sessionId, selected.sessionId);
  f.controller.setVisible(false);
  assert.equal(f.controller.isSelectionCurrent(next), false);
  f.controller.dispose();
});

function fixture(overrides = {}) {
  const calls = { start: [], snapshot: [], stop: [] };
  const states = [];
  const timers = new Map();
  let now = 0;
  let sequence = 0;
  let sessions = 0;
  let snapshot = { status: 'searching', rows: [] };
  const scheduler = {
    setTimeout(callback, milliseconds) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + milliseconds });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const adapter = {
    async start(id) { calls.start.push(id); return overrides.start?.(id); },
    async snapshot(id) { calls.snapshot.push(id); return overrides.snapshot ? overrides.snapshot(id) : { ...snapshot, sessionId: id }; },
    async stop(id) { calls.stop.push(id); return overrides.stop?.(id); },
  };
  const controller = new DiscoveryController({
    supported: true, adapter, scheduler,
    createSessionId: () => `00000000-0000-4000-8000-${String(++sessions).padStart(12, '0')}`,
    onChange: (state) => states.push(state),
    ...overrides.options,
  });
  return {
    controller, calls, states, timers,
    setSnapshot(value) { snapshot = value; },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const entry = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test('discovery starts only on entry and 10-second empty state keeps listening', async () => {
  const f = fixture();
  assert.equal(f.calls.start.length, 0);
  f.controller.start();
  await flush();
  await f.advance(9999);
  assert.equal(f.controller.getState().status, 'searching');
  await f.advance(1);
  assert.equal(f.controller.getState().status, 'empty');
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.snapshot.length, 11);
  f.setSnapshot({ status: 'searching', rows: [row] });
  await f.advance(1000);
  assert.deepEqual(f.controller.getState().rows, [row]);
  assert.equal(f.controller.getState().status, 'searching');
  f.controller.dispose();
});

test('UI applies native removal without inferring TTL from a resolved callback', async () => {
  const f = fixture();
  f.setSnapshot({ status: 'searching', rows: [row] });
  f.controller.start();
  await flush();
  await f.advance(126_000);
  assert.deepEqual(f.controller.getState().rows, [row]);
  f.setSnapshot({ status: 'searching', rows: [] });
  await f.advance(1000);
  assert.deepEqual(f.controller.getState(), { status: 'empty', rows: [] });
  f.controller.dispose();
});

test('late snapshot cannot populate a retried session', async () => {
  const late = deferred();
  let requests = 0;
  const f = fixture({ snapshot: async (id) => ++requests === 1 ? late.promise : { sessionId: id, status: 'searching', rows: [] } });
  f.controller.start();
  await flush();
  const oldId = f.calls.start[0];
  f.controller.retry();
  await flush();
  late.resolve({ sessionId: oldId, status: 'searching', rows: [row] });
  await flush();
  assert.equal(f.calls.start.length, 2);
  assert.ok(f.calls.stop.includes(oldId));
  assert.deepEqual(f.controller.getState().rows, []);
  assert.equal(f.timers.size, 2);
  f.controller.dispose();
});

test('a late native start is stopped before the replacement start runs', async () => {
  const late = deferred();
  const order = [];
  let starts = 0;
  const f = fixture({
    start: async (id) => { order.push(`start:${id}`); if (++starts === 1) await late.promise; },
    stop: async (id) => { order.push(`stop:${id}`); },
  });
  f.controller.start();
  await flush();
  const oldId = f.calls.start[0];
  f.controller.retry();
  await flush();
  assert.equal(f.calls.start.length, 1);
  late.resolve();
  await flush();
  assert.equal(f.calls.start.length, 2);
  assert.ok(order.indexOf(`stop:${oldId}`) < order.indexOf(`start:${f.calls.start[1]}`));
  f.controller.dispose();
});

test('dispose clears timers and suppresses late native results and updates', async () => {
  const late = deferred();
  const f = fixture({ start: () => late.promise });
  f.controller.start();
  await flush();
  f.controller.dispose();
  const delivered = f.states.length;
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.controller.getState().rows, []);
  late.resolve();
  await flush();
  assert.equal(f.calls.snapshot.length, 0);
  assert.ok(f.calls.stop.includes(f.calls.start[0]));
  assert.equal(f.states.length, delivered);
});

test('background, offline, and network change release old sessions and clear candidates', async () => {
  const f = fixture();
  f.setSnapshot({ status: 'searching', rows: [row] });
  f.controller.start();
  await flush();
  f.controller.setVisible(false);
  await flush();
  assert.deepEqual(f.controller.getState(), { status: 'paused', rows: [] });
  assert.equal(f.timers.size, 0);
  f.controller.setVisible(true);
  await flush();
  assert.equal(f.calls.start.length, 2);
  f.controller.setOnline(false);
  await flush();
  assert.deepEqual(f.controller.getState(), { status: 'network_unavailable', rows: [] });
  assert.equal(f.timers.size, 0);
  f.controller.setOnline(true);
  await flush();
  f.setSnapshot({ status: 'searching', rows: [] });
  f.controller.networkChanged();
  assert.deepEqual(f.controller.getState().rows, []);
  await flush();
  assert.equal(f.calls.start.length, 4);
  assert.equal(new Set(f.calls.start).size, 4);
  assert.equal(new Set(f.calls.stop).size, 3);
  f.controller.dispose();
});

test('unsupported web and hidden/offline initial entry open no native session', async () => {
  const web = fixture({ options: { supported: false } });
  web.controller.start();
  await flush();
  assert.equal(web.controller.getState().status, 'unsupported');
  assert.equal(web.calls.start.length, 0);
  assert.equal(web.timers.size, 0);
  const hidden = fixture();
  hidden.controller.setVisible(false);
  hidden.controller.start();
  await flush();
  assert.equal(hidden.calls.start.length, 0);
  hidden.controller.setOnline(false);
  hidden.controller.setVisible(true);
  await flush();
  assert.equal(hidden.controller.getState().status, 'network_unavailable');
  assert.equal(hidden.calls.start.length, 0);
});

test('permission denied requires an explicit native code and retry remains available', async () => {
  for (const [error, expected] of [
    [{ code: 'permission_denied', message: 'denied' }, 'permission_denied'],
    [{ code: 'network_unavailable', message: 'offline' }, 'network_unavailable'],
    [{ code: 'unsupported', message: 'platform' }, 'unsupported'],
    [new Error('permission denied'), 'error'],
  ]) {
    const f = fixture({ start: async () => { throw error; } });
    f.controller.start();
    await flush();
    assert.equal(f.controller.getState().status, expected);
    assert.equal(f.timers.size, 0);
    f.controller.retry();
    await flush();
    assert.equal(f.calls.start.length, 2);
    f.controller.dispose();
  }
});

test('slow snapshot requests do not overlap and wrong-session snapshots fail closed', async () => {
  const late = deferred();
  const f = fixture({ snapshot: () => late.promise });
  f.controller.start();
  await flush();
  await f.advance(20_000);
  assert.equal(f.calls.snapshot.length, 1);
  assert.equal(f.controller.getState().status, 'empty');
  late.resolve({ sessionId: 'different-session', status: 'searching', rows: [row] });
  await flush();
  assert.deepEqual(f.controller.getState(), { status: 'error', rows: [] });
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('browser lifecycle releases event listeners and native ownership on leave', async () => {
  const page = new EventTarget();
  page.hidden = false;
  const browser = new EventTarget();
  const connection = new EventTarget();
  const f = fixture();
  const cleanup = bindDiscoveryLifecycle(f.controller, page, browser, { onLine: true, connection });
  await flush();
  assert.equal(f.calls.start.length, 1);
  browser.dispatchEvent(new Event('pagehide'));
  await flush();
  assert.equal(f.controller.getState().status, 'paused');
  browser.dispatchEvent(new Event('pageshow'));
  await flush();
  assert.equal(f.calls.start.length, 2);
  connection.dispatchEvent(new Event('change'));
  await flush();
  assert.equal(f.calls.start.length, 3);
  cleanup();
  await flush();
  const starts = f.calls.start.length;
  for (const name of ['online', 'offline', 'pageshow']) browser.dispatchEvent(new Event(name));
  page.dispatchEvent(new Event('visibilitychange'));
  connection.dispatchEvent(new Event('change'));
  await flush();
  assert.equal(f.calls.start.length, starts);
  assert.equal(f.timers.size, 0);
});
