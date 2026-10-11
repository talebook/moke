import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
import { prepareOfflineLibraryEntry, prepareReaderReturn, takeReaderReturn, READER_RETURN_TTL_MS } from '../src/lib/reader-return.ts';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository, SERVER_STORAGE_KEY } from '../src/lib/server-registry.ts';
import { mockCrypto } from './helpers/crypto-context.mjs';

const a={id:'a-id',url:'http://a.test',title:'A',addedAt:'2026-10-05T00:00:00Z'};
const b={...a,id:'b-id',url:'http://b.test',title:'B'};
const online={activeServerId:a.id,serverUrl:a.url,offlineMode:false};
function channel() {
  const state={values:new Map(),marker:'',arrival:{pathname:'/library',navigationType:'navigate'}};
  const storage={getItem:key=>state.values.get(key)??null,setItem:(key,value)=>state.values.set(key,value),removeItem:key=>state.values.delete(key)};
  return {state,storage,getMarker:()=>state.marker,setMarker:value=>{state.marker=value;},getArrival:()=>state.arrival};
}
function registry() {
  const values=new Map();
  const disk={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  return {values,repository:new ServerRegistryRepository(disk)};
}

// Browser context/document replacements below are simulations, not native/Web UI evidence.
test('one-use return receipt contains only source identity and preserves the literal reader return route', () => {
  const tab=channel();
  prepareReaderReturn({...online,password:'secret',token:'secret',user:{id:123}},tab,1000);
  assert.equal(JSON.stringify([...tab.state.values]).includes('secret'),false);
  assert.deepEqual(takeReaderReturn([a,b],tab,1001),online);
  assert.equal(takeReaderReturn([a,b],tab,1002),null);
  assert.equal(tab.state.marker,'');
});

test('offline library document entry restores only offline intent, stays in library and cannot replay on cold load', async () => {
  const disk=registry(),tab=channel();
  disk.values.set(SERVER_STORAGE_KEY,JSON.stringify({version:1,state:{savedServers:[a]}}));
  prepareOfflineLibraryEntry(tab);
  const receipt=JSON.parse([...tab.state.values.values()][0]);
  assert.equal(receipt.activeServerId,null);assert.equal(receipt.serverUrl,'');assert.equal(receipt.intent,'offline-library');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>assert.fail('offline entry must not probe a saved server');
  try {
    const arrived=createServerStore(disk.repository,tab);await arrived.getState().loadServers();
    assert.equal(arrived.getState().offlineMode,true);assert.equal(arrived.getState().serverUrl,'');
    assert.equal(arrived.getState().readerReturnTo,null);assert.equal(arrived.getState().user,null);
    assert.deepEqual(arrived.getState().savedServers,[a]);assert.equal('intent' in arrived.getState(),false);
    assert.equal(tab.state.marker,'');assert.equal(tab.state.values.size,0);
    const cold=createServerStore(disk.repository,tab);await cold.getState().loadServers();
    assert.equal(cold.getState().offlineMode,false);
  }finally{globalThis.fetch=originalFetch;}
});

test('offline entry rejects reload/history, foreign paths, missing live markers, expiry and modified intents', () => {
  for(const scenario of ['reload','history','foreign','cold','expired','modified']) {
    const tab=channel();prepareOfflineLibraryEntry(tab,1000);
    if(scenario==='reload')tab.state.arrival.navigationType='reload';
    if(scenario==='history')tab.state.arrival.navigationType='back_forward';
    if(scenario==='foreign')tab.state.arrival.pathname='/shelf';
    if(scenario==='cold')tab.state.marker='';
    if(scenario==='modified'){
      const key=[...tab.state.values.keys()][0],data=JSON.parse(tab.state.values.get(key));
      delete data.intent;tab.state.values.set(key,JSON.stringify(data));
    }
    assert.equal(takeReaderReturn([a],tab,scenario==='expired'?1000+READER_RETURN_TTL_MS:1001),null,scenario);
    assert.equal(tab.state.values.size,0);assert.equal(tab.state.marker,'');
  }
  assert.throws(()=>prepareReaderReturn({...online,intent:'offline-library'},channel()),/无法保存/);
});

test('denied document handoff preparation retains online identity and offline mode before remount', async () => {
  const disk=registry(),tab=channel(),store=createServerStore(disk.repository,tab);
  await store.getState().loadServers();const saved=(await store.getState().saveServer(a.url)).value;
  await store.getState().activateCandidate(store.getState().beginConnection(saved.id).requestId);
  const before=store.getState();
  const denied={...tab,storage:{...tab.storage,setItem(){throw new Error('denied');}}};
  await assert.rejects(store.getState().enterOfflineMode(()=>prepareOfflineLibraryEntry(denied)),/无法保存离线书库跳转信息/);
  assert.equal(store.getState().offlineMode,false);assert.equal(store.getState().sessionId,before.sessionId);
  assert.equal(store.getState().serverUrl,a.url);assert.equal(store.getState().activeServerId,saved.id);
});

test('cold contexts, wrong paths, reload/history, stale/future/deleted/forged-source receipts do not reactivate a server', () => {
  for (const scenario of ['cold','root','welcome','reload','back','expired','future','deleted','wrong-origin','forged-other','forged-expiry','wrong-nonce','corrupt']) {
    const tab=channel();
    prepareReaderReturn(online,tab,1000);
    let servers=[a,b], now=1001;
    if(scenario==='cold')tab.state.marker='';
    if(scenario==='root')tab.state.arrival.pathname='/';
    if(scenario==='welcome')tab.state.arrival.pathname='/welcome';
    if(scenario==='reload')tab.state.arrival.navigationType='reload';
    if(scenario==='back')tab.state.arrival.navigationType='back_forward';
    if(scenario==='expired')now=1000+READER_RETURN_TTL_MS;
    if(scenario==='future')now=999;
    if(scenario==='deleted')servers=[b];
    const key=[...tab.state.values.keys()][0];
    if(scenario==='wrong-origin'){const data=JSON.parse(tab.state.values.get(key));data.serverUrl=b.url;tab.state.values.set(key,JSON.stringify(data));}
    if(scenario==='forged-other'){const data=JSON.parse(tab.state.values.get(key));data.activeServerId=b.id;data.serverUrl=b.url;tab.state.values.set(key,JSON.stringify(data));}
    if(scenario==='forged-expiry'){const data=JSON.parse(tab.state.values.get(key));data.createdAt=1001;tab.state.values.set(key,JSON.stringify(data));}
    if(scenario==='wrong-nonce')tab.state.marker+='-invalid';
    if(scenario==='corrupt')tab.state.values.set(key,'{bad');
    assert.equal(takeReaderReturn(servers,tab,now),null,scenario);
    assert.equal(tab.state.values.size,0,scenario);
    assert.equal(tab.state.marker,'',scenario);
  }
});

test('denied return storage prevents reader launch and removes the browsing-context authority', () => {
  const tab=channel();
  tab.storage.setItem=()=>{throw new Error('denied');};
  assert.throws(()=>prepareReaderReturn(online,tab),/无法保存/);
  assert.equal(tab.state.marker,'');
});

test('return nonce survives missing randomUUID but never uses a weak fallback', (context) => {
  const secure = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  mockCrypto(context, { getRandomValues: secure });
  const tab = channel();
  prepareReaderReturn(online, tab, 1000);
  assert.deepEqual(takeReaderReturn([a], tab, 1001), online);
  prepareReaderReturn(online, tab, 1000);
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  assert.throws(() => prepareReaderReturn(online, tab, 1001), /无法保存.*当前连接已保留.*安全随机数/);
  assert.equal(tab.state.marker, '');
  assert.equal(tab.state.values.size, 0);
});

test('invalid return source clears prior authority and uses the unified retained-connection error', () => {
  for (const serverUrl of ['ftp://a.test', 'http://user:secret@a.test', 'http://a.test/path', 'http://A.test:80', '']) {
    const tab = channel();
    prepareReaderReturn(online, tab, 1000);
    assert.throws(() => prepareReaderReturn({ ...online, serverUrl }, tab, 1001), /无法保存阅读器返回信息，当前连接已保留/);
    assert.equal(tab.state.marker, '');
    assert.equal(tab.state.values.size, 0);
  }
});

test('a denied sessionStorage getter clears an old marker and reports a recoverable launch error', () => {
  const previous=globalThis.window;
  globalThis.window={name:'moke-reader-return:old',get sessionStorage(){throw new Error('denied getter');}};
  try {
    assert.throws(()=>prepareReaderReturn(online),/无法保存/);
    assert.equal(window.name,'');
    window.name='moke-reader-return:old';
    assert.equal(takeReaderReturn([a,b]),null);
    assert.equal(window.name,'');
  }finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});

test('online document return confirms only A before hydration; cold restart only loads the list', async () => {
  const disk=registry(), tab=channel();
  const original=createServerStore(disk.repository,tab);
  await original.getState().loadServers();
  const server=(await original.getState().saveServer(a.url)).value;
  const second=(await original.getState().saveServer(b.url)).value;
  await original.getState().activateCandidate(original.getState().beginConnection(server.id).requestId);
  const listBefore=disk.values.get(SERVER_STORAGE_KEY);
  prepareReaderReturn(original.getState(),tab);
  const originalFetch=globalThis.fetch, requests=[];
  globalThis.fetch=async url=>{
    requests.push(String(url));
    return Response.json(String(url).endsWith('/api/welcome')?{err:'free'}:{err:'ok',user:{is_login:false},sys:{title:'A'}});
  };
  try {
    const returned=createServerStore(disk.repository,tab);
    const load=returned.getState().loadServers();
    assert.equal(returned.getState().hasHydrated,false);
    await load;
    assert.equal(returned.getState().activeServerId,server.id);
    assert.equal(returned.getState().serverUrl,a.url);
    assert.equal(returned.getState().user,null);
    assert.equal(returned.getState().hasHydrated,true);
    assert.deepEqual(requests,[`${a.url}/api/user/info`,`${a.url}/api/welcome`]);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY),listBefore);
    const cold=createServerStore(disk.repository,tab);
    await cold.getState().loadServers();
    assert.equal(cold.getState().serverUrl,'');
    assert.equal(cold.getState().savedServers.length,2);
    assert.equal(requests.length,2);
    assert.notEqual(server.id,second.id);
  } finally {globalThis.fetch=originalFetch;}
});

test('offline document return requires no network and selects the offline shelf', async () => {
  for(const connected of [false,true]) {
    const disk=registry(),tab=channel(),original=createServerStore(disk.repository,tab);
    await original.getState().loadServers();
    if(connected){const saved=(await original.getState().saveServer(a.url)).value;await original.getState().activateCandidate(original.getState().beginConnection(saved.id).requestId);}
    await original.getState().enterOfflineMode();
    prepareReaderReturn(original.getState(),tab);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async()=>{assert.fail('offline return must not connect');};
    try {
      const returned=createServerStore(disk.repository,tab);
      await returned.getState().loadServers();
      assert.equal(returned.getState().offlineMode,true);
      assert.equal(returned.getState().readerReturnTo,'/shelf');
      assert.equal(returned.getState().serverUrl,connected?a.url:'');
    } finally {globalThis.fetch=originalFetch;}
  }
});

test('failed/access-required return is consumed, keeps the list and allows explicit reconnect', async () => {
  for(const mode of ['offline','access']) {
    const disk=registry(),tab=channel(),original=createServerStore(disk.repository,tab);
    await original.getState().loadServers();
    const server=(await original.getState().saveServer(a.url)).value;
    await original.getState().activateCandidate(original.getState().beginConnection(server.id).requestId);
    prepareReaderReturn(original.getState(),tab);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async url=>{if(mode==='offline')throw new Error('unreachable');return Response.json(String(url).endsWith('/api/welcome')?{err:'ok'}:{err:'ok',user:{is_login:false}});};
    try {
      const returned=createServerStore(disk.repository,tab);
      await returned.getState().loadServers();
      assert.equal(returned.getState().serverUrl,'');
      assert.equal(returned.getState().savedServers.length,1);
      assert.match(returned.getState().readerReturnError,/点击原服务器/);
      assert.ok(returned.getState().beginConnection(server.id));
      assert.equal(tab.state.marker,'');
    } finally {globalThis.fetch=originalFetch;}
  }
});

test('B candidate, login, logout and disconnect invalidate an earlier A return receipt', async () => {
  for(const change of ['candidate','login','logout','disconnect','offline']) {
    const disk=registry(),tab=channel(),store=createServerStore(disk.repository,tab);
    await store.getState().loadServers();
    const server=(await store.getState().saveServer(a.url)).value;
    const other=(await store.getState().saveServer(b.url)).value;
    await store.getState().activateCandidate(store.getState().beginConnection(server.id).requestId);
    prepareReaderReturn(store.getState(),tab);
    if(change==='candidate')store.getState().beginConnection(other.id);
    if(change==='login')store.getState().setConnected('',{id:1});
    if(change==='logout')store.getState().logout();
    if(change==='disconnect')store.getState().disconnect();
    if(change==='offline')await store.getState().enterOfflineMode();
    assert.equal(takeReaderReturn(store.getState().savedServers,tab),null,change);
  }
});

test('A return confirmation locks new B candidates until its original load finishes', async () => {
  const disk=registry(),tab=channel(),original=createServerStore(disk.repository,tab);
  await original.getState().loadServers();
  const server=(await original.getState().saveServer(a.url)).value;
  const other=(await original.getState().saveServer(b.url)).value;
  await original.getState().activateCandidate(original.getState().beginConnection(server.id).requestId);
  prepareReaderReturn(original.getState(),tab);
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  const originalFetch=globalThis.fetch,requests=[];
  globalThis.fetch=async url=>{requests.push(String(url));if(String(url).endsWith('/api/user/info')){entered();await wait;}return Response.json(String(url).endsWith('/api/welcome')?{err:'free'}:{err:'ok',user:{is_login:false}});};
  const returned=createServerStore(disk.repository,tab);
  const load=returned.getState().loadServers();
  try {
    await started;
    assert.equal(returned.getState().storageBusy,true);
    assert.equal(returned.getState().beginConnection(other.id),null);
    assert.equal(returned.getState().candidate,null);
    assert.equal(returned.getState().serverUrl,'');
    assert.deepEqual(requests,[`${a.url}/api/user/info`]);
    release();await load;
    assert.equal(returned.getState().storageBusy,false);
    assert.equal(returned.getState().hasHydrated,true);
    assert.equal(returned.getState().serverUrl,a.url);
    assert.equal(returned.getState().activeServerId,server.id);
    assert.equal(returned.getState().candidate,null);
    assert.deepEqual(requests,[`${a.url}/api/user/info`,`${a.url}/api/welcome`]);
    const candidate=returned.getState().beginConnection(other.id);
    assert.equal(candidate.id,other.id);
    assert.equal(returned.getState().candidate,candidate);
    assert.equal(returned.getState().serverUrl,a.url,'starting B preserves confirmed A until activation');
    assert.equal(await returned.getState().activateCandidate(candidate.requestId),true);
    assert.equal(returned.getState().serverUrl,b.url);
  } finally {release();await load;globalThis.fetch=originalFetch;}
});
