import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createServerConnectionController } from '../src/lib/server-connection-controller.ts';

const A = { id: 'native-a', url: 'https://books.example:8443/team/books', entryRevision: 'a-1', status: 'ready' };
const B = { id: 'native-b', url: 'https://other.example:8443/team/books', entryRevision: 'b-1', status: 'ready' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(overrides = {}) {
  const entries = new Map([[A.id, { ...A }], [B.id, { ...B }]]);
  const events = [];
  const activations = [];
  const cleanups = [];
  const states = [];
  let revision = 7;
  let uncertainCalls = 0;
  const controller = createServerConnectionController({
    readEntry: async (id) => {
      events.push(`read:${id}`);
      return entries.has(id) ? { ...entries.get(id) } : null;
    },
    getSessionRevision: () => revision,
    canConnect: async (entry) => { events.push(`guard:${entry.id}`); return true; },
    probe: async (entry) => { events.push(`probe:${entry.id}`); return { needsAccessCode: false }; },
    activate: (entry, expected, prepared) => {
      events.push(`activate:${entry.id}`);
      activations.push({ entry, expected, prepared });
      revision++;
      return true;
    },
    cleanup: (entry, context, reason) => { cleanups.push({ entry, context, reason }); },
    onActivationUncertain: () => { uncertainCalls++; },
    onState: (state) => states.push(state),
    ...overrides,
  });
  return {
    controller, entries, events, activations, cleanups, states,
    setRevision: (value) => { revision = value; },
    uncertainCalls: () => uncertainCalls,
  };
}

test('native receipt is revalidated before projection and is not connected until acknowledgement', { timeout: 2000 }, async () => {
  const receipt = { opaque: 'host-issued-receipt' };
  const acknowledgeStarted = deferred();
  const acknowledgeResult = deferred();
  const contexts = [];
  let fixture;
  fixture = setup({
    prepareActivation: async (entry, context) => {
      fixture.events.push(`prepare:${entry.id}`);
      contexts.push(context);
      assert.deepEqual(entry, A);
      assert.equal(context.attempt, 1);
      assert.equal(context.sessionRevision, 7);
      assert.equal(context.signal.aborted, false);
      return receipt;
    },
    acknowledgeActivation: async (entry, context, prepared) => {
      fixture.events.push(`ack:${entry.id}`);
      contexts.push(context);
      assert.deepEqual(entry, A);
      assert.equal(prepared, receipt);
      acknowledgeStarted.resolve();
      await acknowledgeResult.promise;
    },
  });
  const connecting = fixture.controller.connect(A);
  await acknowledgeStarted.promise;
  assert.deepEqual(fixture.events, [
    'read:native-a', 'guard:native-a', 'probe:native-a',
    'read:native-a', 'guard:native-a', 'prepare:native-a',
    'read:native-a', 'guard:native-a', 'activate:native-a', 'ack:native-a',
  ]);
  assert.deepEqual(fixture.activations, [{ entry: A, expected: 7, prepared: receipt }]);
  assert.equal(contexts[0].signal, contexts[1].signal);
  assert.equal(contexts[1].sessionRevision, 7);
  assert.equal(fixture.controller.getState().phase, 'connecting');
  assert.equal(fixture.states.some((state) => state.phase === 'connected'), false);
  acknowledgeResult.resolve();
  const connected = await connecting;
  assert.equal(connected.phase, 'connected');
  assert.equal(connected.url, A.url);
  assert.equal(connected.entryRevision, A.entryRevision);
  assert.equal(fixture.cleanups.length, 0);
});

test('entry, source and session changes during prepare stop projection after the await', { timeout: 2000 }, async () => {
  for (const scenario of [
    { change: (fixture) => fixture.entries.set(A.id, { ...A, entryRevision: 'a-2' }), code: 'entry-changed' },
    { change: (fixture) => fixture.entries.set(A.id, { ...A, url: `${A.url}/moved` }), code: 'entry-changed' },
    { change: (fixture) => fixture.entries.delete(A.id), code: 'entry-not-found' },
    { change: (fixture) => fixture.entries.set(A.id, { ...A, status: 'needs-edit' }), code: 'entry-unavailable' },
    { change: (fixture) => fixture.setRevision(8), code: 'session-changed' },
    { change: (_fixture, source) => { source.allowed = false; }, code: 'source-in-use' },
  ]) {
    const prepareStarted = deferred();
    const prepared = deferred();
    const source = { allowed: true };
    let acknowledgements = 0;
    const fixture = setup({
      canConnect: async () => source.allowed,
      prepareActivation: async () => { prepareStarted.resolve(); return prepared.promise; },
      acknowledgeActivation: async () => { acknowledgements++; },
    });
    const connecting = fixture.controller.connect(A);
    await prepareStarted.promise;
    scenario.change(fixture, source);
    prepared.resolve({ opaque: 'now-stale-receipt' });
    const result = await connecting;
    assert.equal(result.code, scenario.code);
    assert.equal(result.phase, 'failed');
    assert.equal(fixture.activations.length, 0);
    assert.equal(acknowledgements, 0);
    assert.ok(fixture.cleanups.some(({ entry, context }) => entry.id === A.id && context.attempt === result.attempt));
  }
});

test('cancelled preparation settles immediately and a late native receipt cannot project or acknowledge', { timeout: 2000 }, async () => {
  const prepareStarted = deferred();
  const prepared = deferred();
  let context;
  let acknowledgements = 0;
  const fixture = setup({
    prepareActivation: async (_entry, value) => { context = value; prepareStarted.resolve(); return prepared.promise; },
    acknowledgeActivation: async () => { acknowledgements++; },
  });
  const connecting = fixture.controller.connect(A);
  await prepareStarted.promise;
  fixture.controller.cancel(context.attempt);
  const cancelled = await connecting;
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.code, 'authority-uncertain');
  assert.equal(fixture.uncertainCalls(), 1);
  assert.equal(context.signal.aborted, true);
  assert.ok(fixture.cleanups.some(({ entry, context: cleanupContext }) => entry.id === A.id
    && cleanupContext.signal === context.signal && cleanupContext.attempt === context.attempt));
  prepared.resolve({ opaque: 'late-cancelled-receipt' });
  await nextTurn();
  assert.equal(fixture.activations.length, 0);
  assert.equal(acknowledgements, 0);
  assert.equal(fixture.controller.getState().phase, 'cancelled');
  assert.equal(fixture.states.some((state) => state.phase === 'connected'), false);
});

test('deadline during preparation aborts and cleans the attempt without accepting a late receipt', { timeout: 2000 }, async () => {
  const prepareStarted = deferred();
  const prepared = deferred();
  let context;
  const fixture = setup({
    timeoutMs: 30,
    prepareActivation: async (_entry, value) => { context = value; prepareStarted.resolve(); return prepared.promise; },
  });
  const connecting = fixture.controller.connect(A);
  await prepareStarted.promise;
  const result = await connecting;
  assert.equal(result.phase, 'failed');
  assert.equal(result.code, 'authority-uncertain');
  assert.equal(fixture.uncertainCalls(), 1);
  assert.equal(context.signal.aborted, true);
  assert.ok(fixture.cleanups.some(({ context: cleanupContext }) => cleanupContext.signal === context.signal));
  prepared.resolve({ opaque: 'late-timeout-receipt' });
  await nextTurn();
  assert.equal(fixture.activations.length, 0);
  assert.equal(fixture.controller.getState().code, 'authority-uncertain');
});

test('a new selection supersedes a pending prepare and late A cannot disturb acknowledged B', { timeout: 2000 }, async () => {
  const prepareStarted = deferred();
  const preparedA = deferred();
  const acknowledgements = [];
  let oldContext;
  const fixture = setup({
    prepareActivation: async (entry, context) => {
      if (entry.id === A.id) { oldContext = context; prepareStarted.resolve(); return preparedA.promise; }
      return { entryId: entry.id };
    },
    acknowledgeActivation: async (entry) => { acknowledgements.push(entry.id); },
  });
  const first = fixture.controller.connect(A);
  await prepareStarted.promise;
  const second = fixture.controller.connect(B);
  assert.equal((await first).phase, 'cancelled');
  assert.equal((await second).phase, 'connected');
  assert.equal(oldContext.signal.aborted, true);
  assert.ok(fixture.cleanups.some(({ entry, context }) => entry.id === A.id && context.attempt === oldContext.attempt));
  preparedA.resolve({ opaque: 'superseded-a' });
  await nextTurn();
  assert.deepEqual(fixture.activations.map(({ entry }) => entry.id), [B.id]);
  assert.deepEqual(acknowledgements, [B.id]);
  assert.equal(fixture.controller.getState().entryId, B.id);
  assert.equal(fixture.controller.getState().phase, 'connected');
});

test('unknown native prepare failure closes authority without projecting or leaking internal details', { timeout: 2000 }, async () => {
  const fixture = setup({ prepareActivation: async () => { throw new Error('private host receipt bytes'); } });
  const result = await fixture.controller.connect(A);
  assert.equal(result.phase, 'failed');
  assert.equal(result.code, 'authority-uncertain');
  assert.equal(result.message.includes('private'), false);
  assert.equal(fixture.uncertainCalls(), 1);
  assert.equal(fixture.activations.length, 0);
  assert.equal(fixture.states.some((state) => state.phase === 'connected'), false);
  assert.ok(fixture.cleanups.some(({ entry, reason }) => entry.id === A.id && reason === 'authority-uncertain'));
});

test('unknown acknowledgement failure never announces a projected source as connected', { timeout: 2000 }, async () => {
  const receipt = { opaque: 'unconfirmed-host-receipt' };
  const fixture = setup({
    prepareActivation: async () => receipt,
    acknowledgeActivation: async () => { throw new Error('private lost IPC response'); },
  });
  const result = await fixture.controller.connect(A);
  assert.equal(result.phase, 'failed');
  assert.equal(result.code, 'authority-uncertain');
  assert.equal(result.message.includes('private'), false);
  assert.equal(fixture.uncertainCalls(), 1);
  assert.equal(fixture.activations.length, 1);
  assert.equal(fixture.activations[0].prepared, receipt);
  assert.equal(fixture.states.some((state) => state.phase === 'connected'), false);
  assert.ok(fixture.cleanups.some(({ context, reason }) => context.attempt === result.attempt && reason === 'authority-uncertain'));
});

test('Web without native lifecycle hooks retains the two reads and synchronous activation contract', async () => {
  const fixture = setup();
  const result = await fixture.controller.connect(A);
  assert.equal(result.phase, 'connected');
  assert.deepEqual(fixture.events, [
    'read:native-a', 'guard:native-a', 'probe:native-a',
    'read:native-a', 'guard:native-a', 'activate:native-a',
  ]);
  assert.equal(fixture.activations.length, 1);
  assert.equal(fixture.activations[0].expected, 7);
  assert.equal(fixture.activations[0].prepared, undefined);
  assert.equal(fixture.cleanups.length, 0);
  assert.equal(fixture.uncertainCalls(), 0);
});
