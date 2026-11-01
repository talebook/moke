import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerConnectionController } from '../src/lib/server-connection-controller.ts';
import { NativeConnectionError } from '../src/lib/native-connection.ts';

const A = { id: 'a', url: 'https://books.example:8443/team/books', entryRevision: 'a-1', status: 'ready' };
const B = { id: 'b', url: 'https://books.example:8443/other/books', entryRevision: 'b-1', status: 'ready' };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(overrides = {}) {
  const entries = new Map([[A.id, { ...A }], [B.id, { ...B }]]);
  const activated = [];
  const probed = [];
  const states = [];
  let revision = 7;
  const controller = createServerConnectionController({
    readEntry: async (id) => entries.has(id) ? { ...entries.get(id) } : null,
    getSessionRevision: () => revision,
    canConnect: async () => true,
    probe: async (entry, signal) => { probed.push({ entry, signal }); return { needsAccessCode: false }; },
    activate: (entry, expected) => { activated.push({ entry, expected }); revision++; return true; },
    onState: (state) => states.push(state),
    ...overrides,
  });
  return { controller, entries, activated, probed, states, setRevision: (value) => { revision = value; } };
}

test('confirmed native busy preserves the selected source and requires a fresh explicit retry', async () => {
  let busy = true;
  const f = setup({ canConnect: async () => {
    if (busy) throw new NativeConnectionError('source_busy');
    return true;
  } });
  const rejected = await f.controller.connect(A);
  assert.equal(rejected.code, 'source-busy');
  assert.equal(rejected.url, A.url);
  assert.equal(rejected.entryId, A.id);
  assert.match(rejected.message, /前一请求仍在结束/);
  assert.equal(f.probed.length, 0);
  assert.equal(f.activated.length, 0);
  busy = false;
  await Promise.resolve();
  assert.equal(f.probed.length, 0, 'readiness changes must not replay the operation');
  assert.equal((await f.controller.connect(A)).phase, 'connected');
  assert.equal(f.probed.length, 1);
});

test('native probe busy, source conflicts and unknown authority remain distinct', async () => {
  for (const [error, code] of [
    [new NativeConnectionError('source_busy'), 'source-busy'],
    [new NativeConnectionError('same_hostname_conflict'), 'source-in-use'],
    [new NativeConnectionError('ipc_unknown', true), 'authority-uncertain'],
    [Object.assign(new Error('private native failure'), { code: 'authority-uncertain' }), 'authority-uncertain'],
    [Object.assign(new Error('source_busy'), { code: 'source-in-use', nativeCode: 'source_busy' }), 'probe-failed'],
  ]) {
    let calls = 0;
    const f = setup({ probe: async () => { calls++; throw error; } });
    const result = await f.controller.connect(A);
    assert.equal(result.code, code);
    assert.equal(calls, 1);
    assert.equal(f.activated.length, 0);
    assert.doesNotMatch(result.message, /private native failure/);
  }
});

test('successful selection carries the exact complete base and expected session through both guards', async () => {
  const reads = [];
  const guards = [];
  const fixture = setup({
    readEntry: async (id) => { reads.push(id); return { ...A }; },
    canConnect: async (entry) => { guards.push(entry.url); return true; },
  });
  const result = await fixture.controller.connect(A);
  assert.equal(result.phase, 'connected');
  assert.equal(result.url, A.url);
  assert.deepEqual(reads, ['a', 'a']);
  assert.deepEqual(guards, [A.url, A.url]);
  assert.equal(fixture.probed[0].entry.url, A.url);
  assert.deepEqual(fixture.activated, [{ entry: A, expected: 7 }]);
  assert.deepEqual(fixture.states.map((state) => state.phase), ['connecting', 'connected']);
});

test('same candidate concurrent clicks share one pending attempt and probe', async () => {
  const pending = deferred();
  const started = deferred();
  let probes = 0;
  const { controller } = setup({ probe: async () => { probes++; started.resolve(); return pending.promise; } });
  const first = controller.connect(A);
  const second = controller.connect({ ...A });
  assert.equal(first, second);
  await started.promise;
  assert.equal(probes, 1);
  pending.resolve({ needsAccessCode: false });
  assert.equal((await first).phase, 'connected');
});

test('cancel settles immediately and ignores an abort-insensitive late transport result', async () => {
  const pending = deferred();
  const started = deferred();
  let signal;
  const fixture = setup({ probe: async (_entry, value) => { signal = value; started.resolve(); return pending.promise; } });
  const connecting = fixture.controller.connect(A);
  await started.promise;
  const cancelled = fixture.controller.cancel();
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(signal.aborted, true);
  assert.equal((await connecting).code, 'cancelled');
  pending.resolve({ needsAccessCode: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.activated.length, 0);
  assert.equal(fixture.controller.getState().phase, 'cancelled');
});

test('cancel also bounds a hung authoritative read without starting a network probe', async () => {
  const pending = deferred();
  const fixture = setup({ readEntry: () => pending.promise });
  const connecting = fixture.controller.connect(A);
  fixture.controller.cancel();
  assert.equal((await connecting).phase, 'cancelled');
  pending.resolve({ ...A });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.probed.length, 0);
  assert.equal(fixture.activated.length, 0);
});

test('deadline aborts an ignored probe, supports retry, and never activates the late first response', async () => {
  const pending = deferred();
  let firstSignal;
  let probes = 0;
  const fixture = setup({ timeoutMs: 15, probe: async (_entry, signal) => {
    probes++;
    if (probes === 1) { firstSignal = signal; return pending.promise; }
    return { needsAccessCode: false };
  } });
  const first = await fixture.controller.connect(A);
  assert.equal(first.phase, 'failed');
  assert.equal(first.code, 'timeout');
  assert.equal(firstSignal.aborted, true);
  const second = await fixture.controller.connect(A);
  assert.equal(second.phase, 'connected');
  assert.ok(second.attempt > first.attempt);
  pending.resolve({ needsAccessCode: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.activated.length, 1);
  assert.equal(fixture.controller.getState().attempt, second.attempt);
});

test('late A cannot activate or replace the state after a newer B has connected', async () => {
  const pending = deferred();
  const started = deferred();
  let oldSignal;
  const fixture = setup({ probe: async (entry, signal) => {
    if (entry.id === A.id) { oldSignal = signal; started.resolve(); return pending.promise; }
    return { needsAccessCode: false };
  } });
  const first = fixture.controller.connect(A);
  await started.promise;
  const second = fixture.controller.connect(B);
  assert.equal(oldSignal.aborted, true);
  assert.equal((await first).phase, 'cancelled');
  assert.equal((await second).phase, 'connected');
  pending.resolve({ needsAccessCode: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fixture.activated.map(({ entry }) => entry.id), [B.id]);
  assert.equal(fixture.controller.getState().entryId, B.id);
  assert.equal(fixture.controller.getState().phase, 'connected');
});

test('stale route cancellation cannot abort a newer attempt', async () => {
  const pending = deferred();
  const started = deferred();
  const fixture = setup({ probe: async (entry) => {
    if (entry.id === A.id) return new Promise(() => {});
    started.resolve();
    return pending.promise;
  } });
  const first = fixture.controller.connect(A);
  const oldAttempt = fixture.controller.getState().attempt;
  const second = fixture.controller.connect(B);
  await started.promise;
  fixture.controller.cancel(oldAttempt);
  assert.equal(fixture.controller.getState().entryId, B.id);
  assert.equal(fixture.controller.getState().phase, 'connecting');
  pending.resolve({ needsAccessCode: false });
  assert.equal((await first).phase, 'cancelled');
  assert.equal((await second).phase, 'connected');
});

test('missing, changed and unavailable authoritative entries stop before probing', async () => {
  for (const [entry, code] of [
    [null, 'entry-not-found'],
    [{ ...A, entryRevision: 'a-2' }, 'entry-changed'],
    [{ ...A, url: 'https://books.example:8443/different' }, 'entry-changed'],
    [{ ...A, id: 'different' }, 'entry-changed'],
    [{ ...A, status: 'collision' }, 'entry-unavailable'],
    [{ ...A, status: 'needs-edit' }, 'entry-unavailable'],
  ]) {
    const fixture = setup({ readEntry: async () => entry });
    assert.equal((await fixture.controller.connect(A)).code, code);
    assert.equal(fixture.probed.length, 0);
    assert.equal(fixture.activated.length, 0);
  }
});

test('entry revision or complete address changed during a successful probe cannot activate', async () => {
  for (const changed of [{ ...A, entryRevision: 'a-2' }, { ...A, url: 'https://books.example:8443/b' }, null]) {
    const pending = deferred();
    const started = deferred();
    const fixture = setup({ probe: async () => { started.resolve(); return pending.promise; } });
    const connecting = fixture.controller.connect(A);
    await started.promise;
    if (changed) fixture.entries.set(A.id, changed);
    else fixture.entries.delete(A.id);
    pending.resolve({ needsAccessCode: false });
    const result = await connecting;
    assert.equal(result.code, changed ? 'entry-changed' : 'entry-not-found');
    assert.equal(fixture.activated.length, 0);
  }
});

test('session changes invalidate the old result even when reconnecting the same saved URL', async () => {
  const pending = deferred();
  const started = deferred();
  const fixture = setup({ probe: async () => { started.resolve(); return pending.promise; } });
  const connecting = fixture.controller.connect(A);
  await started.promise;
  fixture.setRevision(8);
  pending.resolve({ needsAccessCode: false });
  assert.equal((await connecting).code, 'session-changed');
  assert.equal(fixture.activated.length, 0);
});

test('source guard failures stop before probing or after probing, preserving the session', async () => {
  for (const rejectCall of [1, 2]) {
    let calls = 0;
    const fixture = setup({ canConnect: async () => ++calls !== rejectCall });
    const result = await fixture.controller.connect(A);
    assert.equal(result.code, 'source-in-use');
    assert.equal(fixture.probed.length, rejectCall === 1 ? 0 : 1);
    assert.equal(fixture.activated.length, 0);
  }
});

test('access-code requirement is an explicit retryable state and cannot activate', async () => {
  let requiresCode = true;
  const fixture = setup({ probe: async () => ({ needsAccessCode: requiresCode }) });
  const needsCode = await fixture.controller.connect(A);
  assert.equal(needsCode.phase, 'failed');
  assert.equal(needsCode.code, 'access-required');
  assert.equal(needsCode.needsAccessCode, true);
  assert.equal(fixture.activated.length, 0);
  requiresCode = false;
  assert.equal((await fixture.controller.connect(A)).phase, 'connected');
  assert.equal(fixture.activated.length, 1);
});

test('rejected activation and external read/guard/probe errors never report connected', async () => {
  for (const [overrides, code] of [
    [{ activate: () => false }, 'activation-rejected'],
    [{ activate: () => { throw new Error('private activation state'); } }, 'activation-rejected'],
    [{ readEntry: async () => { throw new Error('private source bytes'); } }, 'read-failed'],
    [{ canConnect: async () => { throw new Error('private reader state'); } }, 'guard-failed'],
    [{ probe: async () => { throw new Error('private server response'); } }, 'probe-failed'],
    [{ probe: async () => ({}) }, 'probe-failed'],
  ]) {
    const fixture = setup(overrides);
    const result = await fixture.controller.connect(A);
    assert.equal(result.phase, 'failed');
    assert.equal(result.code, code);
    assert.equal(result.message.includes('private'), false);
    assert.equal(fixture.controller.getState().phase, 'failed');
  }
});

test('caller and observer mutations cannot alter selected identity or stored state', async () => {
  const pending = deferred();
  const started = deferred();
  const fixture = setup({
    probe: async () => { started.resolve(); return pending.promise; },
    onState: (state) => { state.phase = 'idle'; state.url = 'https://wrong.example'; },
  });
  const selection = { ...A };
  const connecting = fixture.controller.connect(selection);
  selection.url = 'https://wrong.example';
  selection.entryRevision = 'changed-by-caller';
  await started.promise;
  const snapshot = fixture.controller.getState();
  snapshot.url = 'https://wrong.example';
  assert.equal(fixture.controller.getState().url, A.url);
  assert.equal(fixture.controller.getState().phase, 'connecting');
  pending.resolve({ needsAccessCode: false });
  const result = await connecting;
  result.phase = 'idle';
  assert.equal(fixture.controller.getState().phase, 'connected');
  assert.equal(fixture.activated[0].entry.url, A.url);
});

test('observer failure cannot turn a committed activation into failure', async () => {
  const fixture = setup({ onState: () => { throw new Error('view failed'); } });
  assert.equal((await fixture.controller.connect(A)).phase, 'connected');
  assert.equal(fixture.activated.length, 1);
});

test('new same-entry attempt after a session change supersedes its previous pending attempt', async () => {
  const pending = deferred();
  const started = deferred();
  let probes = 0;
  const fixture = setup({ probe: async () => {
    if (++probes === 1) { started.resolve(); return pending.promise; }
    return { needsAccessCode: false };
  } });
  const first = fixture.controller.connect(A);
  await started.promise;
  fixture.setRevision(8);
  const second = fixture.controller.connect(A);
  assert.notEqual(first, second);
  assert.equal((await first).phase, 'cancelled');
  assert.equal((await second).phase, 'connected');
  assert.equal(fixture.activated[0].expected, 8);
  pending.reject(new Error('ignored late transport failure'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.controller.getState().phase, 'connected');
});

test('timeouts must be finite positive timer durations', () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 2_147_483_648]) {
    assert.throws(() => setup({ timeoutMs }), { message: 'invalid_connection_timeout' });
  }
});
