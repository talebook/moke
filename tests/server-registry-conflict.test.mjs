import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, serializeServerRegistry, parseServerRegistry } from '../src/lib/server-registry.ts';
import { createServerStore } from '../src/lib/store/server.ts';

const a = { id: 'a', url: 'http://a.test', title: 'A', addedAt: '' };
const b = { id: 'b', url: 'http://b.test', title: 'B', addedAt: '' };
const c = { id: 'c', url: 'http://c.test', title: 'C', addedAt: '' };
const externalRaw = serializeServerRegistry({ savedServers: [a, b] });

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values, writes,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, value); },
  };
}

function runtime(state) {
  return Object.fromEntries([
    'serverUrl', 'serverTitle', 'activeServerId', 'protocol', 'host', 'port', 'isConnected',
    'offlineMode', 'user', 'token', 'sessionId', 'connectionId', 'capabilities',
  ].map(key => [key, state[key]]));
}

async function connectedStore(disk) {
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  await store.getState().activateCandidate(store.getState().beginConnection('a').requestId);
  store.getState().setConnected('current-token', { id: 1, name: 'Current account' });
  store.getState().setServerCapabilities({ ...store.getState().capabilities, checkedAt: Date.now() });
  return store;
}

test('external save conflict exposes the list reload action; reloading preserves the live connection and allows a fresh save', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: serializeServerRegistry({ savedServers: [a] }) });
  const store = await connectedStore(disk);
  const before = runtime(store.getState());
  disk.values.set(SERVER_STORAGE_KEY, externalRaw);

  const failed = await store.getState().saveServer(c.url);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /重试加载/);
  // welcome renders its existing retry button when this error is nonempty;
  // the button calls the loadServers action exercised below.
  assert.match(store.getState().storageError, /其他窗口.*重试加载/);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().storageBusy, false);
  assert.deepEqual(store.getState().savedServers, [a]);
  assert.deepEqual(runtime(store.getState()), before);
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), externalRaw);
  assert.deepEqual(disk.writes, []);

  const retryLoad = store.getState().loadServers;
  await retryLoad();
  assert.equal(store.getState().storageError, '');
  assert.equal(store.getState().hasHydrated, true);
  assert.deepEqual(store.getState().savedServers, [a, b]);
  assert.deepEqual(runtime(store.getState()), before);
  assert.deepEqual(disk.writes, []);

  const saved = await store.getState().saveServer(c.url);
  assert.equal(saved.ok, true);
  assert.deepEqual(parseServerRegistry(disk.values.get(SERVER_STORAGE_KEY)).savedServers, [a, b, saved.value]);
  assert.deepEqual(runtime(store.getState()), before);
});

test('title conflicts also expose reload and keep the discovered title, account and connection intact', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: serializeServerRegistry({ savedServers: [a] }) });
  const store = await connectedStore(disk);
  const source = { ...store.getState() };
  const expectedRuntime = { ...runtime(store.getState()), serverTitle: 'Discovered A' };
  disk.values.set(SERVER_STORAGE_KEY, externalRaw);

  await store.getState().setServerTitle('Discovered A', source);
  assert.match(store.getState().storageError, /重试加载/);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().storageBusy, false);
  assert.match(store.getState().serverListNotice, /当前连接已保留/);
  assert.deepEqual(store.getState().savedServers, [a]);
  assert.deepEqual(runtime(store.getState()), expectedRuntime);
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), externalRaw);

  await store.getState().loadServers();
  assert.equal(store.getState().storageError, '');
  assert.deepEqual(store.getState().savedServers, [a, b]);
  assert.deepEqual(runtime(store.getState()), expectedRuntime);
  await store.getState().setServerTitle('Discovered A', source);
  assert.deepEqual(parseServerRegistry(disk.values.get(SERVER_STORAGE_KEY)).savedServers, [{ ...a, title: 'Discovered A' }, b]);
  assert.deepEqual(runtime(store.getState()), expectedRuntime);
});

test('a failed conflict reload keeps the old list and live connection until another reload succeeds', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: serializeServerRegistry({ savedServers: [a] }) });
  const store = await connectedStore(disk);
  const before = runtime(store.getState());
  disk.values.set(SERVER_STORAGE_KEY, externalRaw);
  assert.equal((await store.getState().saveServer(c.url)).ok, false);
  const read = disk.getItem;
  disk.getItem = () => { throw new Error('read denied'); };
  await store.getState().loadServers();
  assert.match(store.getState().storageError, /read denied/);
  assert.deepEqual(store.getState().savedServers, [a]);
  assert.deepEqual(runtime(store.getState()), before);
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), externalRaw);

  disk.getItem = read;
  await store.getState().loadServers();
  assert.equal(store.getState().storageError, '');
  assert.deepEqual(store.getState().savedServers, [a, b]);
  assert.deepEqual(runtime(store.getState()), before);
  assert.deepEqual(disk.writes, []);
});

test('reloading an externally removed active entry preserves its live session without adding it back to the saved list', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: serializeServerRegistry({ savedServers: [a] }) });
  const store = await connectedStore(disk);
  const before = runtime(store.getState());
  const replacement = serializeServerRegistry({ savedServers: [b] });
  disk.values.set(SERVER_STORAGE_KEY, replacement);
  assert.equal((await store.getState().saveServer(c.url)).ok, false);
  await store.getState().loadServers();
  assert.equal(store.getState().storageError, '');
  assert.deepEqual(store.getState().savedServers, [b]);
  assert.deepEqual(runtime(store.getState()), before);
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), replacement);
  const saved = await store.getState().saveServer(c.url);
  assert.equal(saved.ok, true);
  assert.deepEqual(parseServerRegistry(disk.values.get(SERVER_STORAGE_KEY)).savedServers, [b, saved.value]);
  assert.deepEqual(runtime(store.getState()), before);
});

test('changes during damaged-list or legacy-value backup are detected before the final write', async () => {
  for (const mode of ['damaged-list', 'compatibility-only']) {
    const original = mode === 'damaged-list'
      ? JSON.stringify({ version: 1, state: { savedServers: [a, false] } }) : ' null \n';
    const disk = storage(mode === 'damaged-list' ? { [SERVER_STORAGE_KEY]: original } : { moke_server_url: original });
    const repository = new ServerRegistryRepository(disk);
    assert.equal((await repository.load()).ok, true);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const write = disk.setItem;
    const backupPrefix = `${SERVER_STORAGE_KEY}-${mode === 'damaged-list' ? 'damaged-backup-' : 'damaged-legacy-url-backup-'}`;
    disk.setItem = async (key, value) => {
      if (key.startsWith(backupPrefix)) { entered(); await gate; }
      write(key, value);
    };
    const pending = repository.save({ savedServers: [a, c] });
    await started;
    disk.values.set(SERVER_STORAGE_KEY, externalRaw);
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'configuration-changed');
    assert.match(result.error, /重试加载/);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), externalRaw);
    assert.equal(disk.writes.includes(SERVER_STORAGE_KEY), false);
    assert.equal([...disk.values].find(([key]) => key.startsWith(backupPrefix))[1], original);
    assert.deepEqual((await repository.load()).value.savedServers, [a, b]);
    assert.equal((await repository.save({ savedServers: [a, b, c] })).ok, true);
    assert.deepEqual(parseServerRegistry(disk.values.get(SERVER_STORAGE_KEY)).savedServers, [a, b, c]);
  }
});

test('changes during migration or recovery backups preserve the external configuration and return a reload conflict', async () => {
  for (const mode of ['migration', 'recovery']) {
    const original = mode === 'migration' ? JSON.stringify({ version: 0, state: { serverUrl: a.url } }) : '{broken';
    const disk = storage({ [SERVER_STORAGE_KEY]: original });
    const repository = new ServerRegistryRepository(disk);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const write = disk.setItem;
    const backupPrefix = `${SERVER_STORAGE_KEY}-${mode === 'migration' ? 'legacy-backup' : 'backup-'}`;
    disk.setItem = async (key, value) => {
      if (key.startsWith(backupPrefix)) { entered(); await gate; }
      write(key, value);
    };
    const pending = mode === 'migration' ? repository.load() : repository.recover();
    await started;
    disk.values.set(SERVER_STORAGE_KEY, externalRaw);
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'configuration-changed');
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), externalRaw);
    assert.equal(disk.writes.includes(SERVER_STORAGE_KEY), false);
    const backup = [...disk.values].find(([key]) => key.startsWith(backupPrefix))[1];
    assert.equal(mode === 'migration' ? backup : JSON.parse(backup).raw, original);
  }
});
