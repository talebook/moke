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

for (const offline of [false, true]) {
  test(`active access confirmation cannot follow a saved ID reassigned to another origin (offline=${offline})`, async () => {
    const store = connectedStore();
    if (offline) await store.getState().enterOfflineMode();
    store.setState({ savedServers: store.getState().savedServers.map(server =>
      server.id === 'a' ? { ...server, url: 'https://changed.test' } : server) });
    const before = store.getState();
    assert.equal(before.beginActiveAccessConfirmation(), null);
    assertRuntimeUnchanged(store, before);
    assert.equal(store.getState().candidate, null);
    assert.match(store.getState().serverListNotice, /服务器列表/);
    // The new origin is available only after an explicit saved-server choice.
    assert.equal(store.getState().beginConnection('a').url, 'https://changed.test');
  });
}

test('matching saved source can reconfirm access without changing the active identity', () => {
  const store = connectedStore();
  const before = store.getState();
  const candidate = before.beginActiveAccessConfirmation();
  assert.equal(candidate.id, 'a');
  assert.equal(candidate.url, before.serverUrl);
  assert.equal(candidate.needsAccessCode, true);
  assertRuntimeUnchanged(store, before);
});

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
