import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository } from '../src/lib/server-registry.ts';
import { registerReaderProgressFlush } from '../src/lib/reader-source.ts';

function connectedStore() {
  const store = createServerStore(new ServerRegistryRepository({ getItem: () => null, setItem() {} }));
  store.setState({ hasHydrated: true, activeServerId: 'a', serverUrl: 'https://a.test',
    isConnected: true, user: { id: 7 }, token: 'current-session',
    savedServers: [
      { id: 'a', url: 'https://a.test', title: 'A', addedAt: '' },
      { id: 'b', url: 'https://b.test', title: 'B', addedAt: '' },
    ] });
  return store;
}

function assertRuntimeUnchanged(store, before) {
  for (const key of ['serverUrl', 'activeServerId', 'isConnected', 'user', 'token',
    'connectionId', 'sessionId', 'savedServers', 'offlineMode']) {
    assert.equal(store.getState()[key], before[key], `${key} must retain the current connection`);
  }
}

test('a candidate requiring access cannot activate through the ordinary connection path', async () => {
  const store = connectedStore();
  const candidate = store.getState().beginConnection('b');
  store.getState().requireAccess(candidate.requestId);
  const before = store.getState();
  assert.equal(await before.activateCandidate(candidate.requestId), false);
  assertRuntimeUnchanged(store, before);
  assert.equal(store.getState().candidate, before.candidate);
  assert.equal(store.getState().saving, false);
});

test('a matching access confirmation activates the gated candidate and clears the old session', async () => {
  const store = connectedStore();
  const candidate = store.getState().beginConnection('b');
  store.getState().requireAccess(candidate.requestId);
  assert.equal(await store.getState().activateCandidate(candidate.requestId, true), true);
  assert.equal(store.getState().serverUrl, 'https://b.test');
  assert.equal(store.getState().activeServerId, 'b');
  assert.equal(store.getState().candidate, null);
  assert.equal(store.getState().user, null);
  assert.equal(store.getState().token, '');
  assert.equal(store.getState().connectionId, 1);
  assert.equal(store.getState().sessionId, 1);
});

test('access confirmation for an old request cannot authorize a newer candidate', async () => {
  const store = connectedStore();
  const old = store.getState().beginConnection('b');
  store.getState().requireAccess(old.requestId);
  const current = store.getState().beginConnection('b');
  store.getState().requireAccess(current.requestId);
  const before = store.getState();
  assert.equal(await before.activateCandidate(old.requestId, true), false);
  assert.equal(await store.getState().activateCandidate(current.requestId), false);
  assertRuntimeUnchanged(store, before);
  assert.equal(store.getState().candidate, before.candidate);
});

test('activation rechecks an access requirement raised while Reader progress is flushing', async () => {
  const store = connectedStore();
  const candidate = store.getState().beginConnection('b');
  const before = store.getState();
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const unregister = registerReaderProgressFlush(async () => { started(); await pending; });
  try {
    const activation = store.getState().activateCandidate(candidate.requestId);
    await entered;
    store.getState().requireAccess(candidate.requestId);
    release();
    assert.equal(await activation, false);
    assertRuntimeUnchanged(store, before);
    assert.equal(store.getState().candidate.needsAccessCode, true);
    assert.equal(store.getState().saving, false);
  } finally { unregister(); release(); }
});
