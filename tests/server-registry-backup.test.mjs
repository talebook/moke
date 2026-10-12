import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, serializeServerRegistry } from '../src/lib/server-registry.ts';
import { createServerStore } from '../src/lib/store/server.ts';

const a = { id: 'a', url: 'http://a.test', title: 'A', addedAt: '' };
const migratedRaw = JSON.stringify({ version: 0, state: { serverUrl: a.url, user: { id: 1 }, token: 'old-session' } });
const damagedRaw = JSON.stringify({ version: 1, state: { savedServers: [a, false] } });

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values, writes,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, value); },
  };
}

function snapshot(store) {
  return Object.fromEntries(Object.entries(store.getState()).filter(([, value]) => typeof value !== 'function'));
}

async function connect(store) {
  const id = store.getState().savedServers[0].id;
  const candidate = store.getState().beginConnection(id);
  assert.equal(await store.getState().activateCandidate(candidate.requestId), true);
  store.getState().setConnected('live-session', { id: 2, name: 'Current account' });
}

test('only backups verified in this repository instance have a view entry', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: migratedRaw });
  const repository = new ServerRegistryRepository(disk);
  const store = createServerStore(repository);
  assert.equal(store.getState().serverBackupKey, null);
  assert.equal((await store.getState().readServerBackup()).ok, false);
  await store.getState().loadServers();
  assert.equal(store.getState().serverBackupKey, `${SERVER_STORAGE_KEY}-legacy-backup`);
  const restarted = createServerStore(new ServerRegistryRepository(disk));
  await restarted.getState().loadServers();
  assert.equal(restarted.getState().serverBackupKey, null);
  assert.equal((await restarted.getState().readServerBackup()).ok, false);
  assert.equal(disk.values.get(`${SERVER_STORAGE_KEY}-legacy-backup`), migratedRaw);
});

test('viewing a migration backup rereads exact bytes without restoring stored credentials or changing a live session', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: migratedRaw });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  assert.equal(store.getState().serverUrl, '');
  assert.equal(store.getState().token, '');
  assert.equal(store.getState().user, null);
  await connect(store);
  const before = snapshot(store);
  disk.writes.length = 0;
  const result = await store.getState().readServerBackup();
  assert.deepEqual(result, { ok: true, value: { key: `${SERVER_STORAGE_KEY}-legacy-backup`, raw: migratedRaw } });
  assert.deepEqual(snapshot(store), before);
  assert.deepEqual(disk.writes, []);
  assert.equal('serverBackupRaw' in store.getState(), false);
});

test('explicit recovery replaces the latest migration backup entry with the verified recovery envelope', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: migratedRaw, moke_server_url: a.url });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const previousKey = store.getState().serverBackupKey;
  const original = disk.values.get(SERVER_STORAGE_KEY);
  await connect(store);
  await store.getState().recoverServers();
  const key = store.getState().serverBackupKey;
  assert.match(key, /^moke-server-storage-backup-/);
  assert.notEqual(key, previousKey);
  const before = snapshot(store);
  disk.writes.length = 0;
  const result = await store.getState().readServerBackup();
  assert.equal(result.ok, true);
  assert.equal(result.value.key, key);
  assert.equal(JSON.parse(result.value.raw).raw, original);
  assert.equal(JSON.parse(result.value.raw).legacy, a.url);
  assert.deepEqual(snapshot(store), before);
  assert.deepEqual(disk.writes, []);
  assert.deepEqual(store.getState().savedServers, []);
  assert.equal(store.getState().serverUrl, '');
  assert.equal(disk.values.has(previousKey), true);
});

test('save and optional title updates expose the original partially damaged list without repeating successful backups', async () => {
  for (const operation of ['save', 'title']) {
    const disk = storage({ [SERVER_STORAGE_KEY]: damagedRaw });
    const store = createServerStore(new ServerRegistryRepository(disk));
    await store.getState().loadServers();
    assert.equal(store.getState().serverBackupKey, null);
    if (operation === 'title') {
      await connect(store);
      await store.getState().setServerTitle('Discovered A', { ...store.getState() });
    } else assert.equal((await store.getState().saveServer('http://b.test')).ok, true);
    const key = store.getState().serverBackupKey;
    assert.match(key, /^moke-server-storage-damaged-backup-/);
    const before = snapshot(store);
    disk.writes.length = 0;
    assert.deepEqual(await store.getState().readServerBackup(), { ok: true, value: { key, raw: damagedRaw } });
    assert.deepEqual(snapshot(store), before);
    assert.deepEqual(disk.writes, []);
    assert.equal((await store.getState().saveServer('http://c.test')).ok, true);
    assert.equal(store.getState().serverBackupKey, key);
    assert.equal([...disk.values.keys()].filter(value => value.includes('-damaged-backup-')).length, 1);
  }
});

test('a damaged compatibility-only source exposes its exact verified bytes after a later save', async () => {
  const original = ' null \n';
  const disk = storage({ moke_server_url: original });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  assert.equal(store.getState().serverBackupKey, null);
  assert.equal((await store.getState().saveServer(a.url)).ok, true);
  const key = store.getState().serverBackupKey;
  assert.match(key, /^moke-server-storage-damaged-legacy-url-backup-/);
  assert.deepEqual(await store.getState().readServerBackup(), { ok: true, value: { key, raw: original } });
});

test('deleted, tampered or unreadable backup data cannot be shown as a successful verified read', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: migratedRaw });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  await connect(store);
  const key = store.getState().serverBackupKey;
  const read = disk.getItem;
  const before = snapshot(store);
  disk.writes.length = 0;
  for (const failure of ['deleted', 'tampered', 'unreadable']) {
    disk.values.set(key, migratedRaw);
    disk.getItem = read;
    if (failure === 'deleted') disk.values.delete(key);
    if (failure === 'tampered') disk.values.set(key, 'modified bytes');
    if (failure === 'unreadable') disk.getItem = requested => { if (requested === key) throw new Error('read denied'); return read(requested); };
    const result = await store.getState().readServerBackup();
    assert.equal(result.ok, false);
    assert.match(result.error, failure === 'unreadable' ? /read denied/ : /删除或更改/);
    assert.deepEqual(snapshot(store), before);
    assert.deepEqual(disk.writes, []);
  }
  disk.getItem = read;
  disk.values.set(key, migratedRaw);
  assert.equal((await store.getState().readServerBackup()).ok, true);
});

function caseStorage(mode) {
  if (mode === 'migration') return storage({ [SERVER_STORAGE_KEY]: migratedRaw });
  if (mode === 'recovery') return storage({ [SERVER_STORAGE_KEY]: '{broken' });
  if (mode === 'legacy') return storage({ moke_server_url: ' null \n' });
  return storage({ [SERVER_STORAGE_KEY]: damagedRaw });
}

async function performBackup(store, mode) {
  await store.getState().loadServers();
  if (mode === 'recovery') await store.getState().recoverServers();
  if (mode === 'damaged' || mode === 'legacy') return store.getState().saveServer('http://b.test');
}

test('failed, discarded or unreadable verification writes never create a backup view entry', async () => {
  for (const mode of ['migration', 'recovery', 'damaged', 'legacy']) {
    for (const failure of ['rejected', 'discarded', 'verification-read']) {
      const disk = caseStorage(mode);
      const initial = disk.values.get(SERVER_STORAGE_KEY);
      const write = disk.setItem;
      const read = disk.getItem;
      disk.setItem = (key, value) => {
        if (key.includes('-backup')) {
          if (failure === 'rejected') throw new Error('backup denied');
          if (failure === 'discarded') return;
        }
        write(key, value);
      };
      if (failure === 'verification-read') disk.getItem = key => { if (key.includes('-backup')) throw new Error('backup read denied'); return read(key); };
      const repository = new ServerRegistryRepository(disk);
      const store = createServerStore(repository);
      await performBackup(store, mode);
      assert.equal(repository.getLatestBackupKey(), null);
      assert.equal(store.getState().serverBackupKey, null);
      assert.equal((await store.getState().readServerBackup()).ok, false);
      assert.equal(disk.values.get(SERVER_STORAGE_KEY), initial);
    }
  }
});

test('a failed later backup attempt retains the previously verified backup entry', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: migratedRaw });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const key = store.getState().serverBackupKey;
  const write = disk.setItem;
  disk.setItem = (requested, raw) => { if (requested.startsWith(`${SERVER_STORAGE_KEY}-backup-`)) throw new Error('recovery backup denied'); write(requested, raw); };
  await store.getState().recoverServers();
  assert.equal(store.getState().serverBackupKey, key);
  assert.deepEqual(await store.getState().readServerBackup(), { ok: true, value: { key, raw: migratedRaw } });
  assert.equal(store.getState().savedServers.length, 1);
});

test('verified backup remains viewable when the subsequent migration, recovery or save write fails', async () => {
  for (const mode of ['migration', 'recovery', 'damaged', 'legacy']) {
    const disk = caseStorage(mode);
    const initial = disk.values.get(SERVER_STORAGE_KEY);
    const write = disk.setItem;
    disk.setItem = (key, value) => { if (key === SERVER_STORAGE_KEY) throw new Error('configuration write denied'); write(key, value); };
    const repository = new ServerRegistryRepository(disk);
    const store = createServerStore(repository);
    await performBackup(store, mode);
    const key = store.getState().serverBackupKey;
    assert.equal(typeof key, 'string');
    assert.equal(repository.getLatestBackupKey(), key);
    const before = snapshot(store);
    const result = await store.getState().readServerBackup();
    assert.deepEqual(result, { ok: true, value: { key, raw: disk.values.get(key) } });
    assert.deepEqual(snapshot(store), before);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), initial);
    assert.equal(store.getState().serverUrl, '');
    assert.equal(store.getState().token, '');
  }
});

test('a failed title write still exposes its verified backup while preserving the active connection and list', async () => {
  const disk = storage({ [SERVER_STORAGE_KEY]: damagedRaw });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  await connect(store);
  const originalList = store.getState().savedServers;
  const write = disk.setItem;
  disk.setItem = (key, value) => { if (key === SERVER_STORAGE_KEY) throw new Error('configuration write denied'); write(key, value); };
  await store.getState().setServerTitle('Discovered A', { ...store.getState() });
  const key = store.getState().serverBackupKey;
  assert.match(key, /^moke-server-storage-damaged-backup-/);
  assert.deepEqual(await store.getState().readServerBackup(), { ok: true, value: { key, raw: damagedRaw } });
  assert.deepEqual(store.getState().savedServers, originalList);
  assert.equal(store.getState().serverUrl, a.url);
  assert.equal(store.getState().token, 'live-session');
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), damagedRaw);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('backup reads queued during migration, recovery or save wait for verification and expose the completed backup', async () => {
  for (const operation of ['migration', 'recovery', 'save']) {
    const disk = caseStorage(operation === 'save' ? 'damaged' : operation);
    const repository = new ServerRegistryRepository(disk);
    if (operation === 'save') assert.equal((await repository.load()).ok, true);
    const entered = deferred();
    const release = deferred();
    const write = disk.setItem;
    disk.setItem = async (key, raw) => {
      if (key.includes('-backup')) { entered.resolve(); await release.promise; }
      write(key, raw);
    };
    const pending = operation === 'migration' ? repository.load()
      : operation === 'recovery' ? repository.recover() : repository.save({ savedServers: [a] });
    await entered.promise;
    let readSettled = false;
    const read = repository.readLatestBackup().then(result => { readSettled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readSettled, false);
    assert.equal(repository.getLatestBackupKey(), null);
    release.resolve();
    assert.equal((await pending).ok, true);
    const result = await read;
    assert.equal(result.ok, true);
    assert.equal(result.value.key, repository.getLatestBackupKey());
    assert.equal(result.value.raw, disk.values.get(result.value.key));
  }
});

test('migration, recovery and save wait for an in-progress backup read before accessing storage', async () => {
  for (const operation of ['migration', 'recovery', 'save']) {
    const disk = storage({ [SERVER_STORAGE_KEY]: migratedRaw });
    const repository = new ServerRegistryRepository(disk);
    assert.equal((await repository.load()).ok, true);
    const key = repository.getLatestBackupKey();
    const entered = deferred();
    const release = deferred();
    const get = disk.getItem;
    let otherReads = 0;
    disk.getItem = async requested => {
      if (requested === key) { entered.resolve(); await release.promise; }
      else otherReads++;
      return get(requested);
    };
    const read = repository.readLatestBackup();
    await entered.promise;
    // This reload has a real legacy payload to migrate after the read settles.
    if (operation === 'migration') disk.values.set(SERVER_STORAGE_KEY, migratedRaw);
    const pending = operation === 'migration' ? repository.load()
      : operation === 'recovery' ? repository.recover() : repository.save({ savedServers: [a] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(otherReads, 0);
    release.resolve();
    assert.equal((await read).ok, true);
    assert.equal((await pending).ok, true);
    assert.equal(otherReads > 0, true);
  }
});
