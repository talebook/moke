import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerAddress, sameServerAddress } from '../src/lib/server-url.ts';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, parseServerRegistry, serializeServerRegistry, emptyRegistry } from '../src/lib/server-registry.ts';
import { createServerStore } from '../src/lib/store/server.ts';
import { checkSavedServer, readConnectionWelcome } from '../src/lib/server-connection.ts';
import { createReaderProgressQueue } from '../src/lib/reader-progress-queue.ts';
import { assertReaderContext, bindReaderWindow, sourceForReaderEvent } from '../src/lib/reader-source.ts';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test('server origins normalize duplicates and retain protocol/port/IPv6 distinctions', () => {
  assert.equal(normalizeServerAddress(' https://A.example.test:443/ '), 'https://a.example.test');
  assert.equal(normalizeServerAddress('[::1]:8080'), 'http://[::1]:8080');
  assert.equal(sameServerAddress('http://a.test:80', 'http://a.test'), true);
  assert.equal(sameServerAddress('http://a.test:81', 'http://a.test'), false);
  for (const url of ['', 'ftp://a.test', 'https://user:pass@a.test', 'https://a.test/book', 'https://a.test/book/..', 'https://a.test/.', 'https://a.test?x', 'https://a.test#', 'javascript:alert(1)']) assert.throws(() => normalizeServerAddress(url));
});

test('save A/B persists both, never changes active/offline state, and preserves ids across restart', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  store.getState().enterOfflineMode();
  const a = await store.getState().saveServer('https://a.example.test');
  const b = await store.getState().saveServer('http://b.example.test:8080');
  assert.equal(a.ok && b.ok, true);
  assert.equal(store.getState().serverUrl, '');
  assert.equal(store.getState().offlineMode, true);
  assert.equal(store.getState().savedServers.length, 2);
  const duplicate = await store.getState().saveServer('https://A.example.test:443/');
  assert.equal(duplicate.value.id, a.value.id);
  const restarted = createServerStore(new ServerRegistryRepository(disk));
  await restarted.getState().loadServers();
  assert.deepEqual(restarted.getState().savedServers, store.getState().savedServers);
  assert.equal(restarted.getState().serverUrl, '');
  const state = JSON.parse(disk.values.get(SERVER_STORAGE_KEY));
  assert.equal(state.version, 1);
  for (const field of ['user', 'token', 'serverUrl', 'isConnected', 'candidate']) assert.equal(field in state.state, false);
});

test('migration backs up old single config, prefers main key, and is idempotent', async () => {
  const original = JSON.stringify({ version: 0, state: { serverUrl: 'http://A.test:80', serverTitle: 'A', user: { id: 'secret' }, token: 'secret' } });
  const disk = storage({ [SERVER_STORAGE_KEY]: original, moke_server_url: 'http://b.test' });
  const repository = new ServerRegistryRepository(disk);
  const first = await repository.load();
  assert.equal(first.ok, true);
  assert.equal(first.value.savedServers[0].url, 'http://a.test');
  assert.equal(disk.values.get(`${SERVER_STORAGE_KEY}-legacy-backup`), original);
  const second = await new ServerRegistryRepository(disk).load();
  assert.deepEqual(second.value, first.value);
  assert.equal(serializeServerRegistry(first.value).includes('secret'), false);
  assert.equal(parseServerRegistry(null, 'http://b.test').savedServers[0].url, 'http://b.test');
});

test('bad JSON/invalid legacy data remain intact until explicit verified recovery', async () => {
  for (const raw of ['', 'null', 'false', '0', '[]', '{broken', JSON.stringify({ version: 0, state: { serverUrl: 'http://a.test/path' } }), JSON.stringify({version: 2,state:{}})]) {
    const disk = storage({ [SERVER_STORAGE_KEY]: raw });
    const repository = new ServerRegistryRepository(disk);
    assert.equal((await repository.load()).ok, false);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), raw);
    assert.equal((await repository.save(emptyRegistry())).ok, false);
    const recovery = await repository.recover();
    assert.equal(recovery.ok, true);
    const backups = [...disk.values].filter(([key]) => key.startsWith(`${SERVER_STORAGE_KEY}-backup-`));
    assert.equal(JSON.parse(backups[0][1]).raw, raw);
    assert.deepEqual(parseServerRegistry(disk.values.get(SERVER_STORAGE_KEY)), emptyRegistry());
  }
});

test('write rejection and readback mismatch never commit B or report success', async () => {
  for (const mode of ['reject', 'discard']) {
    const disk = storage();
    const store = createServerStore(new ServerRegistryRepository(disk));
    await store.getState().loadServers();
    const a = await store.getState().saveServer('http://a.test');
    const before = disk.values.get(SERVER_STORAGE_KEY);
    disk.setItem = () => { if (mode === 'reject') throw new Error('quota'); };
    const b = await store.getState().saveServer('http://b.test');
    assert.equal(b.ok, false);
    assert.match(b.error, /未保存/);
    assert.deepEqual(store.getState().savedServers, [a.value]);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), before);
    assert.equal(store.getState().saving, false);
  }
});

test('loading errors finish hydration without overwriting unknown data', async () => {
  const disk = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('unexpected write'); } };
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  assert.equal(store.getState().hasHydrated, true);
  assert.match(store.getState().storageError, /原数据已保留/);
  assert.equal((await store.getState().saveServer('http://a.test')).ok, false);
});

test('failed migration preserves original and compatibility data', async () => {
  const raw = JSON.stringify({version:0,state:{serverUrl:'http://a.test'}});
  const disk = storage({[SERVER_STORAGE_KEY]:raw,moke_server_url:'http://b.test'});
  disk.setItem = () => { throw new Error('disk full'); };
  assert.equal((await new ServerRegistryRepository(disk).load()).ok, false);
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), raw);
  assert.equal(disk.values.get('moke_server_url'), 'http://b.test');
});

test('cancelled candidate cannot replace A; B activation resets A user and capabilities', async () => {
  const store = createServerStore(new ServerRegistryRepository(storage()));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  const b = (await store.getState().saveServer('http://b.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  store.getState().setUser({id:1, name:'A'});
  const old = store.getState().beginConnection(b.id);
  store.getState().cancelConnection(old.requestId);
  assert.equal(await store.getState().activateCandidate(old.requestId), false);
  assert.equal(store.getState().serverUrl, a.url);
  assert.equal(store.getState().user.name, 'A');
  const fresh = store.getState().beginConnection(b.id);
  assert.equal(await store.getState().activateCandidate(fresh.requestId), true);
  assert.equal(store.getState().user, null);
  assert.equal(store.getState().serverUrl, b.url);
  assert.equal(store.getState().capabilities.checkedAt, null);
  store.getState().disconnect();
  assert.equal(store.getState().savedServers.length, 2);
});

test('cancellation promptly stops even checks that ignore abort; late response is not used', async () => {
  const controller = new AbortController();
  let finish;
  let welcomeCalls = 0;
  const attempt = checkSavedServer('http://a.test', {
    validate: () => new Promise((resolve) => { finish = resolve; }),
    welcome: async () => { welcomeCalls += 1; return {err:'ok'}; },
  }, controller.signal);
  controller.abort(new Error('timeout'));
  await assert.rejects(attempt, /timeout/);
  finish({err:'ok'});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(welcomeCalls, 0);
});

test('unknown welcome errors cannot masquerade as open access', () => {
  assert.equal(readConnectionWelcome({err:'free'}).needsAccessCode, false);
  assert.equal(readConnectionWelcome({err:'ok'}).needsAccessCode, true);
  assert.equal(readConnectionWelcome({err:'server.busy'}).err, 'server.busy');
  assert.equal(readConnectionWelcome('<html>').err, 'server.invalid_response');
});

test('same bookId progress queues retain immutable source and window ownership after switch', async () => {
  const requests = [];
  const queue = createReaderProgressQueue(async (source, progress) => { requests.push([source.serverUrl, progress.location]); }, 10000);
  const a = {serverUrl:'http://a.test',bookId:'42',sessionId:1};
  const b = {serverUrl:'http://b.test',bookId:'42',sessionId:2};
  queue.schedule(a, {moke_book_id:'42',location:'A-position'});
  queue.schedule(b, {moke_book_id:'42',location:'B-position'});
  a.serverUrl = 'http://changed.test';
  await queue.flush();
  assert.deepEqual(requests, [['http://a.test','A-position'],['http://b.test','B-position']]);
  bindReaderWindow('reader-10', {serverUrl:'http://a.test',bookId:'42',sessionId:1});
  bindReaderWindow('reader-11', b);
  assert.equal(sourceForReaderEvent('reader-10','42').serverUrl, 'http://a.test');
  assert.equal(sourceForReaderEvent('reader-11','42').serverUrl, 'http://b.test');
  assert.equal(sourceForReaderEvent('unknown','42'), null);
  assert.equal(sourceForReaderEvent('reader-10','99'), null);
});

test('cancel during persistence restores last-used metadata and keeps active A', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  const b = (await store.getState().saveServer('http://b.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  const oldSet = disk.setItem;
  let entered;
  const started = new Promise(resolve => { entered=resolve; });
  let release;
  const wait = new Promise(resolve => { release=resolve; });
  disk.setItem = async (key,value) => {
    if(JSON.parse(value).state?.lastUsedServerId===b.id){entered();await wait;}
    oldSet(key,value);
  };
  const attempt=store.getState().beginConnection(b.id);
  const activation=store.getState().activateCandidate(attempt.requestId);
  await started;
  store.getState().cancelConnection(attempt.requestId);
  release();
  assert.equal(await activation,false);
  assert.equal(store.getState().serverUrl,a.url);
  assert.equal(JSON.parse(disk.values.get(SERVER_STORAGE_KEY)).state.lastUsedServerId,a.id);
});

test('stalled native/storage hydration shows a bounded error and blocks racing recovery', async (context) => {
  context.mock.timers.enable({apis:['setTimeout']});
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const disk=storage();
  const read=disk.getItem;
  let delayed=true;
  disk.getItem=async(key)=>{if(delayed){delayed=false;await wait;}return read(key);};
  const store=createServerStore(new ServerRegistryRepository(disk));
  const load=store.getState().loadServers();
  context.mock.timers.tick(8001);
  assert.equal(store.getState().hasHydrated,true);
  assert.match(store.getState().storageError,/超时/);
  assert.equal(store.getState().storageBusy,true);
  await store.getState().recoverServers();
  assert.equal(disk.values.has(SERVER_STORAGE_KEY),false);
  release();await load;
  assert.equal(store.getState().storageBusy,false);
  assert.equal(store.getState().storageError,'');
});

test('delayed reader preparation cannot open after a session change or during a candidate switch', () => {
  const source = { serverUrl: 'http://a.test', bookId: '42', sessionId: 1 };
  assert.doesNotThrow(() => assertReaderContext(source, { sessionId: 1, candidate: null }));
  assert.throws(() => assertReaderContext(source, { sessionId: 2, candidate: null }), /状态已改变/);
  assert.throws(() => assertReaderContext(source, { sessionId: 1, candidate: { url: 'http://b.test' } }), /状态已改变/);
});
