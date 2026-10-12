import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository } from '../src/lib/server-registry.ts';

function connectedStore() {
  const store = createServerStore(new ServerRegistryRepository({ getItem: () => null, setItem() {} }));
  store.setState({ hasHydrated: true, activeServerId: 'a', serverUrl: 'https://a.test',
    savedServers: [{ id: 'a', url: 'https://a.test', title: 'A', addedAt: '' }] });
  return store;
}

test('access confirmation starts a fresh saved candidate without replacing the current connection', () => {
  const store = connectedStore();
  const first = store.getState().beginActiveAccessConfirmation();
  assert.equal(first.id, 'a');
  assert.equal(first.needsAccessCode, true);
  const second = store.getState().beginActiveAccessConfirmation();
  assert.ok(second.requestId > first.requestId);
  assert.equal(store.getState().serverUrl, 'https://a.test');
  assert.equal(store.getState().sessionId, 0);
});

for (const unavailable of [{ activeServerId: null }, { activeServerId: 'missing' }, { saving: true }, { storageError: 'unavailable' }]) {
  test(`unavailable access candidate provides a reconnect notice and preserves runtime/list: ${JSON.stringify(unavailable)}`, () => {
    const store = connectedStore();
    store.setState(unavailable);
    const before = store.getState();
    assert.equal(before.beginActiveAccessConfirmation(), null);
    const after = store.getState();
    assert.equal(after.serverListNotice, '需要重新确认访问码，请从服务器列表重新连接。');
    for (const key of ['serverUrl', 'activeServerId', 'sessionId', 'savedServers', 'saving', 'storageError', 'candidate']) {
      assert.equal(after[key], before[key]);
    }
    store.setState({ activeServerId: 'a', saving: false, storageError: '' });
    assert.equal(store.getState().beginActiveAccessConfirmation().needsAccessCode, true);
    assert.equal(store.getState().serverListNotice, '');
  });
}
