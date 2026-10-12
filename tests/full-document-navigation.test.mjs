import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@tauri-apps/api/window') return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export async function getAllWindows() { return []; }'),
  };
  if (specifier === '@tauri-apps/plugin-os') return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export const platform = () => globalThis.__mokeNavigationOSPlatform();'),
  };
  if (specifier !== '@tauri-apps/api/core') return next(specifier, context);
  return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export const invoke = (...args) => globalThis.__mokeNavigationInvoke(...args);') };
} });
const { navigateFullDocument, openEmbeddedReaderBook } = await import('../src/lib/moke-reader.ts');
const { useServerStore } = await import('../src/lib/store/server.ts');
const { prepareReaderReturn, takeReaderReturn } = await import('../src/lib/reader-return.ts');
const server = { id: 'a', url: 'http://a.test', title: 'A', addedAt: '' };
const onlineContext = { activeServerId: server.id, serverUrl: server.url, offlineMode: false };

async function fixture(run) {
  const previousPlatform=process.env.NEXT_PUBLIC_APP_PLATFORM, previousWindow=globalThis.window;
  const previousState=useServerStore.getState();
  const calls=[];
  const values=new Map();
  process.env.NEXT_PUBLIC_APP_PLATFORM='tauri';
  globalThis.window={name:'',location:{pathname:'/detail',assign:href=>calls.push(['assign',href])},sessionStorage:{
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>{calls.push(['receipt',key]);values.set(key,value);},
    removeItem:key=>values.delete(key),
  }};
  useServerStore.setState({...onlineContext,savedServers:[server],candidate:null});
  globalThis.__mokeNavigationInvoke=async(...args)=>calls.push(['invoke',...args]);
  globalThis.__mokeNavigationOSPlatform=async()=>{throw new Error('synthetic platform probe unavailable');};
  try { await run(calls,values); } finally {
    useServerStore.setState(previousState);
    if(previousPlatform===undefined)delete process.env.NEXT_PUBLIC_APP_PLATFORM;else process.env.NEXT_PUBLIC_APP_PLATFORM=previousPlatform;
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
    delete globalThis.__mokeNavigationInvoke;
    delete globalThis.__mokeNavigationOSPlatform;
  }
}

test('offline handoff preparation precedes document replacement on iOS, Android and OHOS',()=>fixture(async calls=>{
  for(const platform of ['ios','android','ohos']) {
    calls.length=0;
    await navigateFullDocument('/library',()=>assert.fail('unexpected router fallback'),platform,()=>calls.push(['prepare']));
    assert.deepEqual(calls,platform==='ios'?[['prepare'],['assign','/library']]:[['prepare'],['invoke','moke_navigate',{path:'/library'}]]);
  }
}));

test('router navigation does not create a stale document receipt',()=>fixture(async calls=>{
  for(const platform of ['windows','linux','web']) {
    calls.length=0;
    if(platform==='web')process.env.NEXT_PUBLIC_APP_PLATFORM='web';
    await navigateFullDocument('/library',href=>calls.push(['router',href]),platform,()=>assert.fail('router must not prepare a receipt'));
    assert.deepEqual(calls,[['router','/library']]);
  }
}));

test('denied handoff preparation stops all native and fallback navigation',()=>fixture(async calls=>{
  for(const platform of ['ios','android','ohos']) {
    await assert.rejects(navigateFullDocument('/library',()=>assert.fail('cannot fallback after denied receipt'),platform,()=>{throw new Error('denied');}),/denied/);
    assert.deepEqual(calls,[]);
  }
}));

test('Reader early fallback and refused paths never arm a return receipt',()=>fixture(async(calls,values)=>{
  for(const mode of ['unsafe','web','desktop','probe-failed']) {
    calls.length=0;
    process.env.NEXT_PUBLIC_APP_PLATFORM=mode==='web'?'web':'tauri';
    globalThis.__mokeNavigationInvoke=async()=>{throw new Error('synthetic runtime probe unavailable');};
    const platform=mode==='desktop'?'linux':mode==='probe-failed'?undefined:'ios';
    await openEmbeddedReaderBook(mode==='unsafe'?'//foreign.test/reader':'/readest/reader',href=>calls.push(['router',href]),platform);
    assert.equal(calls.some(call=>call[0]==='receipt'),false,mode);
    assert.deepEqual(calls,mode==='unsafe'?[]:[['router','/readest/reader']],mode);
    assert.equal(window.name,'',mode);assert.equal(values.size,0,mode);
    window.location.pathname='/library';
    assert.equal(takeReaderReturn([server]),null,mode);
  }
}));

test('Reader fallbacks after assign or native invocation failure clear the armed receipt before routing',()=>fixture(async(calls,values)=>{
  for(const platform of ['ios','android','ohos']) {
    calls.length=0;
    const failNavigation=()=>{
      assert.match(window.name,/^moke-reader-return:/);
      assert.equal(values.size,1);
      throw new Error('synthetic document navigation failed');
    };
    window.location.assign=failNavigation;
    globalThis.__mokeNavigationInvoke=failNavigation;
    await openEmbeddedReaderBook('/readest/reader',href=>{
      assert.equal(window.name,'','clear authority before calling the router');
      assert.equal(values.size,0);
      calls.push(['router',href]);
    },platform);
    assert.equal(calls.filter(call=>call[0]==='receipt').length,1,platform);
    assert.deepEqual(calls.at(-1),['router','/readest/reader'],platform);
    window.location.pathname='/library';
    assert.equal(takeReaderReturn([server]),null,platform);
  }
}));

test('Reader navigation preserves the receipt only for a successful document handoff',()=>fixture(async(calls,values)=>{
  for(const platform of ['ios','android','ohos']) {
    calls.length=0;
    const acceptNavigation=()=>{
      assert.match(window.name,/^moke-reader-return:/);
      assert.equal(values.size,1);
    };
    window.location.assign=acceptNavigation;
    globalThis.__mokeNavigationInvoke=acceptNavigation;
    await openEmbeddedReaderBook('/readest/reader',()=>assert.fail('unexpected router fallback'),platform);
    assert.equal(calls.filter(call=>call[0]==='receipt').length,1,platform);
    window.location.pathname='/library';
    assert.deepEqual(takeReaderReturn([server]),onlineContext,platform);
    assert.equal(window.name,'');assert.equal(values.size,0);
  }
}));

test('Reader storage and router failures propagate with no remaining handoff authority',()=>fixture(async(calls,values)=>{
  const routeError=new Error('synthetic router failed');
  window.location.assign=()=>{throw new Error('synthetic assign failed');};
  await assert.rejects(openEmbeddedReaderBook('/readest/reader',()=>{throw routeError;},'ios'),error=>error===routeError);
  assert.equal(window.name,'');assert.equal(values.size,0);
  calls.length=0;
  window.sessionStorage.setItem=()=>{throw new Error('synthetic storage denied');};
  await assert.rejects(openEmbeddedReaderBook('/readest/reader',()=>assert.fail('preparation must stop navigation'),'ios'),/无法保存阅读器返回信息/);
  assert.deepEqual(calls,[]);
  assert.equal(window.name,'');assert.equal(values.size,0);
}));

test('disconnect during a platform probe cannot arm the old Reader connection',()=>fixture(async(calls,values)=>{
  globalThis.__mokeNavigationInvoke=async(command)=>{
    assert.equal(command,'moke_runtime_platform');
    useServerStore.getState().disconnect();
    return 'ios';
  };
  await assert.rejects(openEmbeddedReaderBook('/readest/reader',()=>assert.fail('stale preparation cannot route')),/状态已改变/);
  assert.equal(calls.some(call=>call[0]==='receipt'||call[0]==='assign'),false);
  assert.equal(window.name,'');assert.equal(values.size,0);
}));

test('a failed platform probe cannot route an old Reader path after identity changes',()=>fixture(async(calls,values)=>{
  const initialSessionId=useServerStore.getState().sessionId;
  let osProbed=false;
  globalThis.__mokeNavigationInvoke=async(command)=>{
    assert.equal(command,'moke_runtime_platform');
    useServerStore.getState().setUser({id:2,name:'Changed account'});
    throw new Error('synthetic runtime probe failed after identity change');
  };
  globalThis.__mokeNavigationOSPlatform=async()=>{osProbed=true;throw new Error('synthetic OS probe failed');};
  await assert.rejects(openEmbeddedReaderBook('/readest/reader',()=>assert.fail('stale fallback cannot route')),/状态已改变/);
  assert.equal(osProbed,true,'both platform probes fail before fallback is checked');
  assert.equal(useServerStore.getState().serverUrl,server.url,'identity changes keep the same server');
  assert.ok(useServerStore.getState().sessionId>initialSessionId);
  assert.equal(calls.some(call=>call[0]==='receipt'||call[0]==='assign'),false);
  assert.equal(window.name,'');assert.equal(values.size,0);
}));

test('native rejection after a session change clears its receipt and cannot route the old Reader path',()=>fixture(async(calls,values)=>{
  globalThis.__mokeNavigationInvoke=async(command)=>{
    assert.equal(command,'moke_navigate');
    assert.match(window.name,/^moke-reader-return:/);
    useServerStore.getState().setUser({id:2,name:'Changed account'});
    throw new Error('synthetic native navigation rejected after identity change');
  };
  await assert.rejects(openEmbeddedReaderBook('/readest/reader',()=>assert.fail('stale fallback cannot route'),'android'),/状态已改变/);
  assert.equal(calls.filter(call=>call[0]==='receipt').length,1);
  assert.equal(window.name,'');assert.equal(values.size,0);
}));

test('a refused Reader open clears any receipt from an earlier abandoned handoff',()=>fixture(async(calls,values)=>{
  prepareReaderReturn(onlineContext);
  assert.equal(values.size,1);
  await openEmbeddedReaderBook('//foreign.test/reader',()=>assert.fail('unsafe route must be refused'),'ios');
  assert.equal(window.name,'');assert.equal(values.size,0);
  window.location.pathname='/library';
  assert.equal(takeReaderReturn([server]),null);
}));
