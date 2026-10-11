import test from 'node:test';
import assert from 'node:assert/strict';
import { writeActiveServerMirror } from '../src/lib/server-storage.ts';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository } from '../src/lib/server-registry.ts';

test('disconnect and optional mirror updates preserve an invalid compatibility-only address across restart', async () => {
  const previousWindow = globalThis.window;
  try {
    for (const raw of [' null \n', 'undefined', 'http://a.test/path']) {
      const values = new Map([['moke_server_url', raw]]);
      const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
      };
      globalThis.window = { localStorage: storage };
      const store = createServerStore(new ServerRegistryRepository(storage));
      await store.getState().loadServers();
      assert.equal(store.getState().storageError, '');
      store.getState().disconnect();
      writeActiveServerMirror('http://b.test');
      assert.equal(values.get('moke_server_url'), raw);
      const reopened = await new ServerRegistryRepository(storage).load();
      assert.equal(reopened.ok, true);
      assert.match(reopened.notice, /旧服务器地址无效/);
      assert.equal(values.get('moke_server_url'), raw);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('valid compatibility mirrors still track active connection and disconnect', () => {
  const previousWindow = globalThis.window;
  const values = new Map([['moke_server_url', 'http://a.test']]);
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } };
  try {
    writeActiveServerMirror('http://b.test');
    assert.equal(values.get('moke_server_url'), 'http://b.test');
    writeActiveServerMirror('');
    assert.equal(values.has('moke_server_url'), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
