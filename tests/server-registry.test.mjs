import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerAddress, sameServerAddress } from '../src/lib/server-url.ts';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, parseServerRegistry, serializeServerRegistry, emptyRegistry } from '../src/lib/server-registry.ts';
import { createServerStore } from '../src/lib/store/server.ts';
import { checkSavedServer, readConnectionWelcome } from '../src/lib/server-connection.ts';
import { createReaderProgressQueue } from '../src/lib/reader-progress-queue.ts';
import { assertReaderContext, bindReaderWindow, sourceForReaderEvent, withClosedReaderSession, openReaderFromSource, requireClosedReaders, registerReaderProgressFlush } from '../src/lib/reader-source.ts';
import { mockCrypto } from './helpers/crypto-context.mjs';

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
  await store.getState().enterOfflineMode();
  const a = await store.getState().saveServer('https://a.example.test');
  const b = await store.getState().saveServer('http://b.example.test:8080');
  assert.equal(a.ok && b.ok, true);
  assert.equal(store.getState().serverUrl, '');
  assert.equal(store.getState().offlineMode, true);
  assert.equal(store.getState().savedServers.length, 2);
  const duplicate = await store.getState().saveServer('https://A.example.test:443/');
  assert.equal(a.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.value.id, a.value.id);
  const restarted = createServerStore(new ServerRegistryRepository(disk));
  await restarted.getState().loadServers();
  assert.deepEqual(restarted.getState().savedServers, store.getState().savedServers);
  assert.equal(restarted.getState().serverUrl, '');
  assert.equal(restarted.getState().offlineMode, false);
  const state = JSON.parse(disk.values.get(SERVER_STORAGE_KEY));
  assert.equal(state.version, 1);
  for (const field of ['user', 'token', 'serverUrl', 'isConnected', 'candidate', 'offlineMode', 'lastUsedServerId']) assert.equal(field in state.state, false);
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

test('cancel during the reserved progress flush keeps active A and the saved list intact', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  const b = (await store.getState().saveServer('http://b.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  const before = disk.values.get(SERVER_STORAGE_KEY);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const remove = registerReaderProgressFlush(async () => { entered(); await wait; });
  try {
    const attempt = store.getState().beginConnection(b.id);
    const activation = store.getState().activateCandidate(attempt.requestId);
    await started;
    store.getState().cancelConnection(attempt.requestId);
    release();
    assert.equal(await activation, false);
    assert.equal(store.getState().serverUrl, a.url);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), before);
  } finally { remove(); release(); }
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
  assert.match(store.getState().storageError,/完全退出并重新启动应用/);
  assert.equal(store.getState().storageBusy,true);
  await store.getState().recoverServers();
  assert.equal(disk.values.has(SERVER_STORAGE_KEY),false);
  release();await load;
  assert.equal(store.getState().storageBusy,false);
  assert.equal(store.getState().storageError,'');
});

test('missing Web Crypto still migrates, saves distinct servers, restarts and backs up recovery', async (context) => {
  mockCrypto(context, undefined);
  const old = JSON.stringify({ version: 0, state: { serverUrl: 'http://a.test', serverTitle: 'A' } });
  const disk = storage({ [SERVER_STORAGE_KEY]: old });
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  assert.equal(store.getState().storageError, '');
  const a = store.getState().savedServers[0];
  const b = await store.getState().saveServer('http://b.test');
  assert.equal(b.ok, true);
  assert.notEqual(a.id, b.value.id);
  const restarted = createServerStore(new ServerRegistryRepository(disk));
  await restarted.getState().loadServers();
  assert.deepEqual(restarted.getState().savedServers, [a, b.value]);
  await restarted.getState().recoverServers();
  assert.equal(restarted.getState().storageError, '');
  assert.deepEqual(restarted.getState().savedServers, []);
  assert.equal([...disk.values.keys()].filter(key => key.startsWith(`${SERVER_STORAGE_KEY}-backup-`)).length, 1);
});

test('identity construction or unexpected storage errors return a visible save failure and release the reservation', async (context) => {
  mockCrypto(context, undefined);
  const store = createServerStore(new ServerRegistryRepository(storage()));
  await store.getState().loadServers();
  const random = context.mock.method(Math, 'random', () => { throw new Error('identity failed'); });
  const result = await store.getState().saveServer('http://a.test');
  assert.equal(result.ok, false);
  assert.match(result.error, /未保存.*identity failed/);
  assert.equal(store.getState().saving, false);
  assert.deepEqual(store.getState().savedServers, []);
  random.mock.restore();
  assert.equal((await store.getState().saveServer('http://a.test')).ok, true);
});

test('discovered titles persist only to their confirmed source and unchanged titles do not rewrite', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  const b = (await store.getState().saveServer('http://b.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  const sourceA = { ...store.getState() };
  await store.getState().setServerTitle('A 最新书库', sourceA);
  assert.equal(store.getState().savedServers[0].title, 'A 最新书库');
  const before = disk.values.get(SERVER_STORAGE_KEY);
  const write = disk.setItem;
  let writes = 0;
  disk.setItem = (key, value) => { writes++; write(key, value); };
  await store.getState().setServerTitle('A 最新书库', sourceA);
  assert.equal(writes, 0);
  await store.getState().activateCandidate(store.getState().beginConnection(b.id).requestId);
  await store.getState().setServerTitle('A 迟到名称', sourceA);
  assert.equal(store.getState().serverTitle, '');
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), before);
  const sourceB = { ...store.getState() };
  store.getState().logout();
  await store.getState().setServerTitle('B 旧会话名称', sourceB);
  assert.equal(store.getState().serverTitle, '');
  const restarted = createServerStore(new ServerRegistryRepository(disk));
  await restarted.getState().loadServers();
  assert.deepEqual(restarted.getState().savedServers.map(s => s.title), ['A 最新书库', '']);
});

test('title write failure or verification mismatch preserves the saved title and connection with a visible retry notice', async () => {
  for (const mode of ['reject', 'discard']) {
    const disk = storage({ [SERVER_STORAGE_KEY]: serializeServerRegistry({ savedServers: [{ id: 'a', url: 'http://a.test', title: '旧名称', addedAt: '' }] }) });
    const store = createServerStore(new ServerRegistryRepository(disk));
    await store.getState().loadServers();
    await store.getState().activateCandidate(store.getState().beginConnection('a').requestId);
    const source = { ...store.getState() };
    const before = disk.values.get(SERVER_STORAGE_KEY);
    disk.setItem = () => { if (mode === 'reject') throw new Error('quota'); };
    await store.getState().setServerTitle('新名称', source);
    assert.equal(store.getState().serverTitle, '新名称');
    assert.equal(store.getState().savedServers[0].title, '旧名称');
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), before);
    assert.match(store.getState().serverListNotice, /名称未保存.*请重试.*当前连接已保留/);
    assert.equal(store.getState().storageError, '');
    assert.equal(store.getState().serverUrl, 'http://a.test');
    assert.equal(store.getState().sessionId, source.sessionId);
    assert.equal(store.getState().saving, false);
    assert.ok(store.getState().beginConnection('a'));
  }
});

test('delayed title persistence cannot overwrite the runtime title after disconnect and reconnect', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  const b = (await store.getState().saveServer('http://b.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = disk.setItem;
  disk.setItem = async (key, value) => { entered(); await gate; write(key, value); };
  const updating = store.getState().setServerTitle('A 新名称', { ...store.getState() });
  await started;
  assert.equal((await store.getState().saveServer('http://c.test')).ok, false);
  store.getState().disconnect();
  assert.equal(store.getState().serverTitle, '');
  release(); await updating;
  await store.getState().activateCandidate(store.getState().beginConnection(b.id).requestId);
  assert.equal(store.getState().serverTitle, '');
  assert.deepEqual(store.getState().savedServers.map(s => s.title), ['A 新名称', '']);
});

test('delayed reader preparation cannot open after a session change or during a candidate switch', () => {
  const source = { serverUrl: 'http://a.test', bookId: '42', sessionId: 1 };
  assert.doesNotThrow(() => assertReaderContext(source, { sessionId: 1, candidate: null }));
  assert.throws(() => assertReaderContext(source, { sessionId: 2, candidate: null }), /状态已改变/);
  assert.throws(() => assertReaderContext(source, { sessionId: 1, candidate: { url: 'http://b.test' } }), /状态已改变/);
});

test('authentication reserves the Reader boundary and releases it on success and failure', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const change = withClosedReaderSession(async () => { entered(); await wait; });
  await started;
  await assert.rejects(openReaderFromSource({ serverUrl: 'http://a.test', bookId: '42', sessionId: 1 }, {}), /状态正在变更/);
  await assert.rejects(requireClosedReaders(), /正在变更登录状态/);
  await assert.rejects(withClosedReaderSession(async () => {}), /状态正在变更/);
  release(); await change;
  await assert.doesNotReject(requireClosedReaders());
  await assert.rejects(withClosedReaderSession(async () => { throw new Error('login failed'); }), /login failed/);
  await assert.doesNotReject(requireClosedReaders());
});

test('read-only existing lists still connect without writing connection metadata', async () => {
  const raw = JSON.stringify({version:1,state:{savedServers:[{id:'a',url:'http://a.test',title:'A',addedAt:''}],offlineMode:true,lastUsedServerId:'a'}});
  const disk = storage({[SERVER_STORAGE_KEY]:raw});
  let writes = 0;
  disk.setItem = () => { writes++; throw new Error('quota'); };
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  assert.equal(store.getState().storageError, '');
  assert.equal(store.getState().offlineMode, false);
  assert.equal(await store.getState().activateCandidate(store.getState().beginConnection('a').requestId), true);
  assert.equal(store.getState().serverUrl, 'http://a.test');
  assert.equal(writes, 0);
  assert.equal((await store.getState().saveServer('http://b.test')).ok, false);
  assert.equal(store.getState().serverUrl, 'http://a.test');
});

test('invalid display metadata degrades without dropping server identities', () => {
  const registry = parseServerRegistry(JSON.stringify({version:1,state:{savedServers:[
    {id:'a',url:'http://a.test',title:null,addedAt:42},
    {id:'b',url:'http://b.test',title:'B',addedAt:'2026-10-11'},
  ]}}));
  assert.deepEqual(registry.savedServers, [
    {id:'a',url:'http://a.test',title:'',addedAt:''},
    {id:'b',url:'http://b.test',title:'B',addedAt:'2026-10-11'},
  ]);
  for (const bad of [{id:42,url:'http://a.test'},{id:'a',url:'http://a.test/path'}]) {
    assert.throws(() => parseServerRegistry(JSON.stringify({version:1,state:{savedServers:[bad]}})));
  }
});

test('successful recovery disconnects the runtime and cancels a stale candidate', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  store.getState().setConnected('test-token', {id:1,name:'A'});
  const stale = store.getState().beginConnection(a.id);
  const before = store.getState().sessionId;
  await store.getState().recoverServers();
  for (const field of ['serverUrl','token']) assert.equal(store.getState()[field], '');
  for (const field of ['activeServerId','user','candidate']) assert.equal(store.getState()[field], null);
  assert.equal(store.getState().isConnected, false);
  assert.equal(store.getState().offlineMode, false);
  assert.equal(store.getState().sessionId, before + 1);
  assert.deepEqual(store.getState().savedServers, []);
  assert.equal(await store.getState().activateCandidate(stale.requestId), false);
  assert.equal(JSON.parse([...disk.values].find(([key]) => key.startsWith(`${SERVER_STORAGE_KEY}-backup-`))[1]).raw.includes(a.id), true);
});

test('failed recovery preserves the active connection and original list', async () => {
  const disk = storage();
  const store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  const a = (await store.getState().saveServer('http://a.test')).value;
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  disk.setItem = () => { throw new Error('backup failed'); };
  await store.getState().recoverServers();
  assert.equal(store.getState().serverUrl, a.url);
  assert.deepEqual(store.getState().savedServers, [a]);
  assert.match(store.getState().storageError, /backup failed/);
});
