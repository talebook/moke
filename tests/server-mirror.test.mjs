import test from 'node:test';
import assert from 'node:assert/strict';
import { writeActiveServerMirror } from '../src/lib/server-storage.ts';
import { createServerStore } from '../src/lib/store/server.ts';
import { SERVER_STORAGE_KEY, ServerRegistryRepository } from '../src/lib/server-registry.ts';

const backupValues = values => [...values.entries()]
  .filter(([key]) => key.startsWith(`${SERVER_STORAGE_KEY}-damaged-legacy-url-backup-`))
  .map(([, value]) => value);

function memoryStorage(values) {
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('disconnect backs up exact invalid mirror bytes before clearing, before or after a tolerant load', async () => {
  const previousWindow = globalThis.window;
  try {
    for (const raw of [' null \n', 'undefined', 'http://a.test/path']) for (const loaded of [false, true]) {
      const values = new Map([['moke_server_url', raw]]);
      const storage = memoryStorage(values);
      globalThis.window = { localStorage: storage };
      const store = createServerStore(new ServerRegistryRepository(storage));
      if (loaded) {
        await store.getState().loadServers();
        assert.equal(store.getState().storageError, '');
        assert.equal(values.get('moke_server_url'), raw, 'loading alone preserves the original');
      }
      store.getState().disconnect();
      assert.equal(values.has('moke_server_url'), false);
      assert.deepEqual(backupValues(values), [raw]);
      const reopened = await new ServerRegistryRepository(storage).load();
      assert.equal(reopened.ok, true);
      assert.deepEqual(reopened.value.savedServers, []);
      assert.equal(reopened.notice, undefined);
      assert.deepEqual(backupValues(values), [raw]);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('a damaged mirror resumes connection updates after its verified backup and remains recoverable after restart', async () => {
  const previousWindow = globalThis.window;
  try {
    const raw = ' http://broken.test/path?书=旧 \n';
    const values = new Map([['moke_server_url', raw]]);
    const storage = memoryStorage(values);
    globalThis.window = { localStorage: storage };
    const store = createServerStore(new ServerRegistryRepository(storage));
    await store.getState().loadServers();
    assert.equal(writeActiveServerMirror('http://b.test'), true);
    assert.equal(values.get('moke_server_url'), 'http://b.test');
    assert.deepEqual(backupValues(values), [raw]);
    const saved = await store.getState().saveServer('http://b.test');
    assert.equal(saved.ok, true);
    const reopened = await new ServerRegistryRepository(storage).load();
    assert.equal(reopened.ok, true);
    assert.equal(reopened.value.savedServers[0].url, 'http://b.test');
    assert.equal(backupValues(values).every(value => value === raw), true);
    assert.equal(writeActiveServerMirror('http://c.test'), true);
    assert.equal(values.get('moke_server_url'), 'http://c.test');
    assert.equal(writeActiveServerMirror(''), true);
    assert.equal(values.has('moke_server_url'), false);
    assert.equal(backupValues(values).every(value => value === raw), true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('failed damaged-mirror backup or verification preserves the original and reports failure', () => {
  const previousWindow = globalThis.window;
  try {
    for (const failure of ['quota', 'dropped', 'corrupted', 'read-denied']) for (const next of ['', 'http://b.test']) {
      const raw = ' null \n';
      const values = new Map([['moke_server_url', raw]]);
      const storage = memoryStorage(values);
      globalThis.window = { localStorage: {
        ...storage,
        getItem: key => {
          if (key !== 'moke_server_url' && failure === 'read-denied') throw new Error('read denied');
          return storage.getItem(key);
        },
        setItem: (key, value) => {
          if (key === 'moke_server_url') return storage.setItem(key, value);
          if (failure === 'quota') throw new Error('quota exceeded');
          if (failure === 'dropped') return;
          storage.setItem(key, failure === 'corrupted' ? 'incorrect backup' : value);
        },
      } };
      assert.equal(writeActiveServerMirror(next), false);
      assert.equal(values.get('moke_server_url'), raw);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('a mirror changed during damaged-value backup is preserved instead of overwritten', () => {
  const previousWindow = globalThis.window;
  const raw = 'undefined';
  const values = new Map([['moke_server_url', raw]]);
  const storage = memoryStorage(values);
  globalThis.window = { localStorage: {
    ...storage,
    setItem: (key, value) => {
      storage.setItem(key, value);
      if (key !== 'moke_server_url') storage.setItem('moke_server_url', 'http://other-window.test');
    },
  } };
  try {
    assert.equal(writeActiveServerMirror(''), false);
    assert.equal(values.get('moke_server_url'), 'http://other-window.test');
    assert.deepEqual(backupValues(values), [raw]);
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
    assert.equal(writeActiveServerMirror('http://b.test'), true);
    assert.equal(values.get('moke_server_url'), 'http://b.test');
    assert.equal(writeActiveServerMirror(''), true);
    assert.equal(values.has('moke_server_url'), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('an optional mirror write that storage ignores is reported as unsuccessful', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  try { assert.equal(writeActiveServerMirror('http://b.test'), false); }
  finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
