import test from 'node:test';
import assert from 'node:assert/strict';

const ACTIVE_KEY = 'moke-active-session-v1';
const LEGACY_KEY = 'moke-server-storage';
const MIRROR_KEY = 'moke_server_url';
let importSequence = 0;

async function loadStore(t, initial = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map(Object.entries(initial));
  const calls = [];
  const localStorage = {
    getItem(key) { calls.push(['get', key]); return values.get(key) ?? null; },
    setItem(key, value) { calls.push(['set', key]); values.set(key, value); },
    removeItem(key) { calls.push(['remove', key]); values.delete(key); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage,
    // Hydration's fallback timer is irrelevant to these synchronous fixtures;
    // do not leave any timers from an isolated module instance running.
    setTimeout() { return 0; },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  const url = new URL('../src/lib/store/server.ts', import.meta.url);
  url.searchParams.set('saved-session-fixture', String(++importSequence));
  const { useServerStore: store, DEFAULT_SERVER_CAPABILITIES } = await import(url.href);
  return { store, values, calls, defaults: DEFAULT_SERVER_CAPABILITIES,
    writes: () => calls.filter(([operation]) => operation === 'set' || operation === 'remove') };
}

function reader(id) {
  return { id, username: `reader-${id}`, name: `Reader ${id}`, email: '', avatar: '', admin: false, permission: '' };
}

function activate(store, entry, revision = store.getState().sessionRevision) {
  return store.getState().activateSavedServer(entry, revision);
}

test('legacy state is a cold-read source while all runtime persistence uses only the new active key', async (t) => {
  const legacyRaw = JSON.stringify({ version: 0, state: { serverUrl: 'https://legacy.example', untouched: { original: true } } }, null, 2);
  const mirrorRaw = 'https://old-mirror.example';
  const f = await loadStore(t, { [LEGACY_KEY]: legacyRaw, [MIRROR_KEY]: mirrorRaw });
  assert.equal(f.store.getState().serverUrl, 'https://legacy.example');
  assert.ok(f.calls.some(([operation, key]) => operation === 'get' && key === LEGACY_KEY));
  f.store.getState().setServerTitle('New runtime title');
  f.store.getState().setConnected('fixture-runtime-token', reader(3));
  f.store.getState().invalidateSession();
  f.store.getState().enterOfflineMode();
  f.store.getState().leaveOfflineMode();
  f.store.getState().logout();
  f.store.getState().disconnect();
  assert.equal(f.values.get(LEGACY_KEY), legacyRaw);
  assert.equal(f.values.get(MIRROR_KEY), mirrorRaw);
  assert.ok(f.values.has(ACTIVE_KEY));
  assert.ok(f.writes().length > 0);
  assert.ok(f.writes().every(([, key]) => key === ACTIVE_KEY));
});

test('the new active key wins over old configuration and keeps its complete saved identity', async (t) => {
  const activeRaw = JSON.stringify({ version: 0, state: {
    serverUrl: 'https://active.example:8443/team/books', savedServerId: 'saved-active',
    savedEntryRevision: 'entry-active', sessionRevision: 17,
  } });
  const legacyRaw = JSON.stringify({ version: 0, state: { serverUrl: 'https://legacy.example' } });
  const f = await loadStore(t, { [ACTIVE_KEY]: activeRaw, [LEGACY_KEY]: legacyRaw });
  const state = f.store.getState();
  assert.equal(state.serverUrl, 'https://active.example:8443/team/books');
  assert.equal(state.savedServerId, 'saved-active');
  assert.equal(state.savedEntryRevision, 'entry-active');
  assert.equal(state.sessionRevision, 17);
  assert.equal(f.values.get(LEGACY_KEY), legacyRaw);
  assert.ok(f.writes().every(([, key]) => key === ACTIVE_KEY));
});

test('activation preserves the full canonical base and stable saved id/revision while starting a fresh session', async (t) => {
  const f = await loadStore(t);
  f.store.getState().enterOfflineMode();
  const before = f.store.getState().sessionRevision;
  assert.equal(activate(f.store, { id: 'saved-a', url: 'https://books.example:8443/team/books', entryRevision: 'entry-a' }, before), true);
  const state = f.store.getState();
  assert.equal(state.serverUrl, 'https://books.example:8443/team/books');
  assert.equal(state.savedServerId, 'saved-a');
  assert.equal(state.savedEntryRevision, 'entry-a');
  assert.equal(state.protocol, 'https');
  assert.equal(state.host, 'books.example');
  assert.equal(state.port, '8443');
  assert.equal(state.offlineMode, false);
  assert.equal(state.sessionRevision, before + 1);
  assert.equal(state.token, '');
  assert.equal(state.user, null);
  assert.equal(state.serverTitle, '');
  assert.deepEqual(state.capabilities, f.defaults);
  const persisted = JSON.parse(f.values.get(ACTIVE_KEY)).state;
  assert.equal(persisted.serverUrl, state.serverUrl);
  assert.equal(persisted.savedServerId, 'saved-a');
  assert.equal(persisted.savedEntryRevision, 'entry-a');
  assert.ok(f.writes().every(([, key]) => key === ACTIVE_KEY));
});

test('switching saved servers clears confirmed credentials, title and capabilities instead of copying A into B', async (t) => {
  const f = await loadStore(t);
  assert.equal(activate(f.store, { id: 'saved-a', url: 'https://a.example', entryRevision: 'entry-a' }), true);
  f.store.getState().setConnected('fixture-a-token', reader(1));
  f.store.getState().setServerTitle('A confirmed title');
  f.store.getState().setServerCapabilities({ ...f.defaults, checkedAt: 12345, version: 'A', shelfApi: true, annotationApiStatus: 'supported' });
  const before = f.store.getState().sessionRevision;
  assert.equal(activate(f.store, { id: 'saved-b', url: 'https://b.example/library', entryRevision: 'entry-b' }), true);
  const b = f.store.getState();
  assert.equal(b.sessionRevision, before + 1);
  assert.equal(b.token, '');
  assert.equal(b.user, null);
  assert.equal(b.serverTitle, '');
  assert.deepEqual(b.capabilities, f.defaults);
  assert.equal(b.savedServerId, 'saved-b');
  assert.equal(b.savedEntryRevision, 'entry-b');
  assert.equal(b.serverUrl, 'https://b.example/library');
});

test('same-origin /a and /b reconnects never reuse the other library credentials', async (t) => {
  const f = await loadStore(t);
  const a = { id: 'saved-a', url: 'https://books.example/a', entryRevision: 'entry-a' };
  const b = { id: 'saved-b', url: 'https://books.example/b', entryRevision: 'entry-b' };
  assert.equal(activate(f.store, a), true);
  f.store.getState().setConnected('fixture-a-token', reader(1));
  assert.equal(activate(f.store, b), true);
  assert.equal(f.store.getState().user, null);
  assert.equal(f.store.getState().token, '');
  f.store.getState().setConnected('fixture-b-token', reader(2));
  assert.equal(activate(f.store, a), true);
  assert.equal(f.store.getState().serverUrl, a.url);
  assert.equal(f.store.getState().savedServerId, a.id);
  assert.equal(f.store.getState().user, null);
  assert.equal(f.store.getState().token, '');
});

test('a stale expected session revision refuses activation without any state or persistence change', async (t) => {
  const f = await loadStore(t);
  assert.equal(activate(f.store, { id: 'saved-a', url: 'https://a.example', entryRevision: 'entry-a' }), true);
  const stale = f.store.getState().sessionRevision;
  f.store.getState().setConnected('fixture-a-token', reader(1));
  const before = f.store.getState();
  const raw = f.values.get(ACTIVE_KEY);
  const writes = f.writes().length;
  assert.equal(activate(f.store, { id: 'saved-b', url: 'https://b.example', entryRevision: 'entry-b' }, stale), false);
  assert.strictEqual(f.store.getState(), before);
  assert.equal(f.values.get(ACTIVE_KEY), raw);
  assert.equal(f.writes().length, writes);
});

test('disconnect clears both saved identity fields as well as the current connection', async (t) => {
  const f = await loadStore(t);
  assert.equal(activate(f.store, { id: 'saved-a', url: 'https://books.example/team', entryRevision: 'entry-a' }), true);
  f.store.getState().setConnected('fixture-token', reader(7));
  const before = f.store.getState().sessionRevision;
  f.store.getState().disconnect();
  const state = f.store.getState();
  assert.equal(state.savedServerId, null);
  assert.equal(state.savedEntryRevision, null);
  assert.equal(state.serverUrl, '');
  assert.equal(state.token, '');
  assert.equal(state.user, null);
  assert.equal(state.sessionRevision, before + 1);
  const persisted = JSON.parse(f.values.get(ACTIVE_KEY)).state;
  assert.equal(persisted.savedServerId, null);
  assert.equal(persisted.savedEntryRevision, null);
  assert.ok(f.writes().every(([, key]) => key === ACTIVE_KEY));
});
