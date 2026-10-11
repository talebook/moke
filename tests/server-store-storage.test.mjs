import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, serializeServerRegistry } from '../src/lib/server-registry.ts';
import { prepareReaderReturn } from '../src/lib/reader-return.ts';
import { useDebugLogStore } from '../src/lib/debug-log.ts';

const a = { id: 'a-id', url: 'http://private-a.test:8080', title: 'A', addedAt: '' };
const b = { id: 'b-id', url: 'https://private-b.test', title: 'B', addedAt: '' };
const damagedMirror = 'http://mirror-user:mirror-secret@legacy.test/private?token=legacy-secret';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

function disk() {
  return memoryStorage({ [SERVER_STORAGE_KEY]: serializeServerRegistry({ savedServers: [a, b] }) });
}

function returnChannel() {
  const storage = memoryStorage();
  let marker = '';
  return {
    storage, getMarker: () => marker, setMarker: value => { marker = value; },
    getArrival: () => ({ pathname: '/library', navigationType: 'navigate' }),
  };
}

async function inBrowser(run, damaged = false) {
  const previousWindow = globalThis.window;
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  const browser = memoryStorage(damaged ? { moke_server_url: damagedMirror } : {});
  const write = browser.setItem;
  if (damaged) browser.setItem = (key, value) => {
    if (key.startsWith(`${SERVER_STORAGE_KEY}-damaged-legacy-url-backup-`)) throw new Error('backup denied');
    return write(key, value);
  };
  globalThis.window = { name: '', localStorage: browser };
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
  useDebugLogStore.getState().clear();
  try { await run(browser); }
  finally {
    useDebugLogStore.getState().clear();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  }
}

function assertMirrorWarning(operation) {
  const logs = useDebugLogStore.getState().logs.filter(entry => entry.tag === 'server-storage');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /镜像未同步.*不受影响/);
  assert.deepEqual(JSON.parse(logs[0].detail), { operation });
  assert.doesNotMatch(JSON.stringify(logs), /https?:\/\/|private-a|private-b|legacy\.test|mirror-user|mirror-secret|legacy-secret|active-secret|private-account/);
}

function runtime(state) {
  return Object.fromEntries([
    'serverUrl', 'serverTitle', 'activeServerId', 'protocol', 'host', 'port', 'isConnected',
    'offlineMode', 'user', 'token', 'sessionId', 'connectionId', 'capabilities',
  ].map(key => [key, state[key]]));
}

test('failed connection mirror logs a safe warning while activation and the saved list remain successful', () => inBrowser(async browser => {
  const storage = disk();
  const raw = storage.getItem(SERVER_STORAGE_KEY);
  const store = createServerStore(new ServerRegistryRepository(storage));
  await store.getState().loadServers();
  const candidate = store.getState().beginConnection(a.id);
  assert.equal(await store.getState().activateCandidate(candidate.requestId), true);
  assert.equal(store.getState().serverUrl, a.url);
  assert.equal(store.getState().activeServerId, a.id);
  assert.equal(store.getState().isConnected, true);
  assert.equal(store.getState().storageError, '');
  assert.equal(store.getState().saving, false);
  assert.deepEqual(store.getState().savedServers, [a, b]);
  assert.equal(storage.getItem(SERVER_STORAGE_KEY), raw);
  assert.equal(browser.getItem('moke_server_url'), damagedMirror);
  assertMirrorWarning('connection');
}, true));

test('failed disconnect mirror logs a safe warning while clearing the live account and retaining the list', () => inBrowser(async browser => {
  const storage = disk();
  const raw = storage.getItem(SERVER_STORAGE_KEY);
  const store = createServerStore(new ServerRegistryRepository(storage));
  await store.getState().loadServers();
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  store.getState().setConnected('active-secret', { id: 9, name: 'private-account' });
  useDebugLogStore.getState().clear();
  store.getState().disconnect();
  assert.equal(store.getState().serverUrl, '');
  assert.equal(store.getState().activeServerId, null);
  assert.equal(store.getState().isConnected, false);
  assert.equal(store.getState().user, null);
  assert.equal(store.getState().token, '');
  assert.equal(store.getState().storageError, '');
  assert.deepEqual(store.getState().savedServers, [a, b]);
  assert.equal(storage.getItem(SERVER_STORAGE_KEY), raw);
  assert.equal(browser.getItem('moke_server_url'), damagedMirror);
  assertMirrorWarning('disconnect');
}, true));

test('failed reader-return mirror logs a safe warning without invalidating the consumed return or hydration', () => inBrowser(async browser => {
  const storage = disk();
  const raw = storage.getItem(SERVER_STORAGE_KEY);
  const channel = returnChannel();
  // An offline Reader return takes the same mirror path without network mocks.
  prepareReaderReturn({ activeServerId: a.id, serverUrl: a.url, offlineMode: true }, channel);
  const store = createServerStore(new ServerRegistryRepository(storage), channel);
  await store.getState().loadServers();
  assert.equal(store.getState().hasHydrated, true);
  assert.equal(store.getState().storageBusy, false);
  assert.equal(store.getState().storageError, '');
  assert.equal(store.getState().readerReturnError, '');
  assert.equal(store.getState().activeServerId, a.id);
  assert.equal(store.getState().serverUrl, a.url);
  assert.equal(store.getState().offlineMode, true);
  assert.equal(store.getState().user, null);
  assert.deepEqual(store.getState().savedServers, [a, b]);
  assert.equal(storage.getItem(SERVER_STORAGE_KEY), raw);
  assert.equal(browser.getItem('moke_server_url'), damagedMirror);
  assert.equal(channel.getMarker(), '');
  assert.equal(channel.storage.values.size, 0);
  assertMirrorWarning('reader-return');
}, true));

test('successful mirrors produce no failure diagnostics during reader return, disconnect and a new connection', () => inBrowser(async browser => {
  const channel = returnChannel();
  prepareReaderReturn({ activeServerId: a.id, serverUrl: a.url, offlineMode: true }, channel);
  const store = createServerStore(new ServerRegistryRepository(disk()), channel);
  await store.getState().loadServers();
  assert.equal(browser.getItem('moke_server_url'), a.url);
  store.getState().disconnect();
  assert.equal(browser.getItem('moke_server_url'), null);
  assert.equal(await store.getState().activateCandidate(store.getState().beginConnection(b.id).requestId), true);
  assert.equal(browser.getItem('moke_server_url'), b.url);
  assert.deepEqual(useDebugLogStore.getState().logs.filter(entry => entry.tag === 'server-storage'), []);
}));

test('external configuration conflicts cancel stale candidates and preserve the current account through a required reload', () => inBrowser(async () => {
  for (const writeKind of ['new-server', 'title']) {
    const storage = disk();
    const store = createServerStore(new ServerRegistryRepository(storage));
    await store.getState().loadServers();
    await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
    store.getState().setConnected('active-secret', { id: 9, name: 'private-account' });
    const before = runtime(store.getState());
    const stale = store.getState().beginConnection(b.id);
    const replacement = { ...b, url: 'http://replacement.test:9000' };
    const external = serializeServerRegistry({ savedServers: [a, replacement] });
    storage.setItem(SERVER_STORAGE_KEY, external);

    if (writeKind === 'new-server') assert.equal((await store.getState().saveServer('http://c.test')).ok, false);
    else await store.getState().setServerTitle('Discovered A', before);
    const expected = { ...before, ...(writeKind === 'title' ? { serverTitle: 'Discovered A' } : {}) };
    assert.match(store.getState().storageError, /其他窗口.*重试加载/);
    assert.equal(store.getState().candidate, null);
    assert.equal(store.getState().beginConnection(b.id), null);
    assert.equal(await store.getState().activateCandidate(stale.requestId), false);
    assert.deepEqual(runtime(store.getState()), expected);
    assert.deepEqual(store.getState().savedServers, [a, b]);
    assert.equal(storage.getItem(SERVER_STORAGE_KEY), external);

    await store.getState().loadServers();
    assert.equal(store.getState().storageError, '');
    assert.deepEqual(store.getState().savedServers, [a, replacement]);
    assert.deepEqual(runtime(store.getState()), expected);
    assert.equal(await store.getState().activateCandidate(stale.requestId), false);
    const fresh = store.getState().beginConnection(b.id);
    assert.equal(fresh.url, replacement.url);
    assert.notEqual(fresh.requestId, stale.requestId);
    assert.equal(await store.getState().activateCandidate(fresh.requestId), true);
    assert.equal(store.getState().serverUrl, replacement.url);
  }
}));

test('ordinary permission failures retain connectable lists and do not cancel an existing candidate', () => inBrowser(async () => {
  for (const writeKind of ['new-server', 'title']) {
    const storage = disk();
    const raw = storage.getItem(SERVER_STORAGE_KEY);
    const store = createServerStore(new ServerRegistryRepository(storage));
    await store.getState().loadServers();
    await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
    store.getState().setConnected('active-secret', { id: 9, name: 'private-account' });
    const before = runtime(store.getState());
    const candidate = store.getState().beginConnection(b.id);
    storage.setItem = () => { throw new Error('write permission denied'); };
    if (writeKind === 'new-server') assert.equal((await store.getState().saveServer('http://c.test')).ok, false);
    else {
      await store.getState().setServerTitle('Discovered A', before);
      assert.match(store.getState().serverListNotice, /write permission denied.*当前连接已保留/);
    }
    const expected = { ...before, ...(writeKind === 'title' ? { serverTitle: 'Discovered A' } : {}) };
    assert.equal(store.getState().storageError, '');
    assert.deepEqual(store.getState().candidate, candidate);
    assert.deepEqual(runtime(store.getState()), expected);
    assert.deepEqual(store.getState().savedServers, [a, b]);
    assert.equal(storage.getItem(SERVER_STORAGE_KEY), raw);
    assert.equal(await store.getState().activateCandidate(candidate.requestId), true);
    assert.equal(store.getState().serverUrl, b.url);
    assert.notEqual(store.getState().beginConnection(a.id), null);
  }
}));
