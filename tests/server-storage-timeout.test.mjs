import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, serializeServerRegistry } from '../src/lib/server-registry.ts';
import { prepareReaderReturn } from '../src/lib/reader-return.ts';
import { registerReaderProgressFlush } from '../src/lib/reader-source.ts';

const a = { id: 'a', url: 'https://a.test', title: 'A', addedAt: '' };
const b = { id: 'b', url: 'https://b.test', title: 'B', addedAt: '' };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function storage(raw = serializeServerRegistry({ savedServers: [a, b] })) {
  const values = new Map([[SERVER_STORAGE_KEY, raw]]), calls = [];
  return {
    values, calls,
    getItem: key => { calls.push({kind:'read',key}); return values.get(key) ?? null; },
    setItem: (key, value) => { calls.push({kind:'write',key}); values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}
function returnChannel() {
  const disk = storage(), marker = {value:''};
  return {storage:disk,getMarker:() => marker.value,setMarker:value => {marker.value=value;},
    getArrival:() => ({pathname:'/library',navigationType:'navigate'})};
}
function runtime(state) {
  return Object.fromEntries(['activeServerId','serverUrl','serverTitle','offlineMode','user','token',
    'connectionId','sessionId','isConnected','capabilities'].map(key => [key,state[key]]));
}
function delayRead(disk) {
  const gate = deferred(), read = disk.getItem;
  let first = true;
  disk.getItem = async key => {
    if (first) {first=false; await gate.promise;}
    return read(key);
  };
  return gate;
}

for (const afterTimeout of [false, true]) {
  test(`offline exit ${afterTimeout ? 'after timeout' : 'before timeout'} retains the read lock and cannot race another operation`, async context => {
    context.mock.timers.enable({apis:['setTimeout']});
    const disk = storage(), gate = delayRead(disk), channel = returnChannel();
    prepareReaderReturn({activeServerId:a.id,serverUrl:a.url,offlineMode:true}, channel);
    const store = createServerStore(new ServerRegistryRepository(disk), channel);
    const load = store.getState().loadServers();
    try {
      if (afterTimeout) {
        context.mock.timers.tick(8001);
        assert.equal(store.getState().hasHydrated, true);
        assert.match(store.getState().storageError, /先使用离线书库/);
      }
      await store.getState().enterOfflineMode();
      assert.equal(store.getState().hasHydrated, true);
      assert.equal(store.getState().storageBusy, true);
      const before = runtime(store.getState()), transitions = [];
      const unsubscribe = store.subscribe(state => transitions.push(state.hasHydrated));
      const duplicate = store.getState().loadServers();
      await store.getState().recoverServers();
      assert.equal((await store.getState().saveServer('https://c.test')).ok, false);
      assert.deepEqual(disk.calls, [], 'no second read, migration or recovery can start');
      gate.resolve(); await Promise.all([load, duplicate]);
      unsubscribe();
      assert.equal(transitions.includes(false), false, 'the late list cannot hide the offline page');
      assert.deepEqual(runtime(store.getState()), before);
      assert.deepEqual(store.getState().savedServers, [a, b]);
      assert.equal(store.getState().storageBusy, false);
      assert.equal(store.getState().storageError, '');
      assert.equal(channel.getMarker(), '', 'offline entry revokes the Reader return authority');
      assert.equal(disk.calls.filter(call => call.kind === 'write').length, 0);
      assert.equal((await store.getState().saveServer('https://c.test')).ok, true);
    } finally {gate.resolve(); await load;}
  });
}

test('a late legacy migration cannot race an early offline save or hide its page', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  const original = JSON.stringify({version:0,state:{serverUrl:a.url,serverTitle:a.title}});
  const disk = storage(original), entered = deferred(), gate = deferred(), write = disk.setItem;
  let first = true;
  disk.setItem = async (key, value) => {
    if (first) {first=false; entered.resolve(); await gate.promise;}
    write(key, value);
  };
  const store = createServerStore(new ServerRegistryRepository(disk));
  const load = store.getState().loadServers();
  try {
    await entered.promise;
    await store.getState().enterOfflineMode();
    const session = store.getState().sessionId, before = disk.calls.length, transitions = [];
    const unsubscribe = store.subscribe(state => transitions.push(state.hasHydrated));
    assert.equal((await store.getState().saveServer('https://c.test')).ok, false);
    await store.getState().recoverServers();
    assert.equal(disk.calls.length, before);
    context.mock.timers.tick(8001);
    assert.equal(store.getState().storageBusy, true);
    gate.resolve(); await load; unsubscribe();
    assert.equal(transitions.includes(false), false);
    assert.equal(store.getState().offlineMode, true);
    assert.equal(store.getState().sessionId, session);
    assert.deepEqual(store.getState().savedServers.map(server => server.url), [a.url]);
    assert.equal([...disk.values.entries()].some(([key,value]) => key.includes('backup') && value === original), true);
  } finally {gate.resolve(); await load;}
});

test('an unfinished reload blocks candidate activation while retaining the current shelf and account', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  const disk = storage(), store = createServerStore(new ServerRegistryRepository(disk));
  await store.getState().loadServers();
  await store.getState().activateCandidate(store.getState().beginConnection(a.id).requestId);
  store.getState().setConnected('fixture-token', {id:1,name:'Current account'});
  const candidate = store.getState().beginConnection(b.id);
  const before = runtime(store.getState()), gate = delayRead(disk);
  const load = store.getState().loadServers();
  try {
    assert.equal(await store.getState().activateCandidate(candidate.requestId), false);
    assert.equal(store.getState().beginConnection(b.id), null);
    context.mock.timers.tick(8001);
    assert.match(store.getState().storageError, /返回当前书架/);
    store.getState().cancelConnection();
    const calls = disk.calls.length, duplicate = store.getState().loadServers();
    await store.getState().recoverServers();
    assert.equal(disk.calls.length, calls);
    assert.deepEqual(runtime(store.getState()), before);
    const transitions = [], unsubscribe = store.subscribe(state => transitions.push(state.hasHydrated));
    gate.resolve(); await Promise.all([load,duplicate]); unsubscribe();
    assert.equal(transitions.includes(false), false);
    assert.deepEqual(runtime(store.getState()), before);
    assert.equal(await store.getState().activateCandidate(candidate.requestId), false);
  } finally {gate.resolve(); await load;}
});

test('a rejected best-effort progress flush permits offline exit without releasing the registry read lock', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  const disk = storage(), gate = delayRead(disk), store = createServerStore(new ServerRegistryRepository(disk));
  const load = store.getState().loadServers();
  const remove = registerReaderProgressFlush(async () => {throw new Error('Reader progress cannot be flushed');});
  try {
    const session = store.getState().sessionId;
    await store.getState().enterOfflineMode();
    assert.equal(store.getState().offlineMode, true);
    assert.equal(store.getState().sessionId, session + 1);
    assert.equal(store.getState().hasHydrated, true);
    assert.equal(store.getState().storageBusy, true);
  } finally {remove(); gate.resolve(); await load;}
});

test('a Reader-return confirmation finishing after offline entry cannot restore its connection', async context => {
  const channel = returnChannel(), entered = deferred(), gate = deferred();
  prepareReaderReturn({activeServerId:a.id,serverUrl:a.url,offlineMode:false}, channel);
  context.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/api/user/info')) {entered.resolve(); await gate.promise; return Response.json({err:'ok'});}
    return Response.json({err:'free'});
  });
  const store = createServerStore(new ServerRegistryRepository(storage()), channel);
  const load = store.getState().loadServers();
  try {
    await entered.promise;
    await store.getState().enterOfflineMode();
    const before = runtime(store.getState()), transitions = [];
    const unsubscribe = store.subscribe(state => transitions.push(state.hasHydrated));
    gate.resolve(); await load; unsubscribe(); await nextTurn();
    assert.deepEqual(runtime(store.getState()), before);
    assert.equal(store.getState().serverUrl, '');
    assert.equal(store.getState().offlineMode, true);
    assert.equal(transitions.includes(false), false);
    assert.equal(store.getState().readerReturnError, '');
  } finally {gate.resolve(); await load;}
});
