import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// A real top-level-await module gate exercises the asynchronous native import,
// rather than pausing an invoke that has already passed the preparation hook.
let moduleId=0;
registerHooks({resolve(specifier,context,next){
  if(specifier==='@tauri-apps/api/window')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export async function getAllWindows(){return [];}')};
  if(specifier==='@tauri-apps/api/core')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
    const host=globalThis.__readerNavigationImport;
    host.started();
    await host.gate;
    if(host.loadError)throw host.loadError;
    export async function invoke(...args){host.calls.push(['invoke',...args]);}
    // Unique module ${++moduleId}: each case must perform a fresh module load.
  `)};
  return next(specifier,context);
}});
const {openEmbeddedReaderBook}=await import('../src/lib/moke-reader.ts');
const {useServerStore}=await import('../src/lib/store/server.ts');

async function fixture(run){
  const previousWindow=globalThis.window,previousPlatform=process.env.NEXT_PUBLIC_APP_PLATFORM;
  const previousState=useServerStore.getState();
  const values=new Map(),localValues=new Map(),calls=[];
  const pending=[];
  let started,release;
  const entered=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  globalThis.__readerNavigationImport={started,gate,calls,loadError:null};
  const storage=map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
  globalThis.window={name:'',sessionStorage:storage(values),localStorage:storage(localValues),location:{pathname:'/detail',assign:href=>calls.push(['assign',href])}};
  process.env.NEXT_PUBLIC_APP_PLATFORM='tauri';
  useServerStore.setState({activeServerId:'a',serverUrl:'http://a.test',offlineMode:false,candidate:null,user:{id:1,name:'Original account'},token:'session-a',sessionId:previousState.sessionId+1});
  try{await run({values,calls,entered,release,host:globalThis.__readerNavigationImport,trackOpening:promise=>{pending.push(promise);return promise;}});}
  finally{
    release();
    await Promise.allSettled(pending);
    useServerStore.setState(previousState);
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
    if(previousPlatform===undefined)delete process.env.NEXT_PUBLIC_APP_PLATFORM;else process.env.NEXT_PUBLIC_APP_PLATFORM=previousPlatform;
    delete globalThis.__readerNavigationImport;
  }
}

for(const platform of ['android','ohos']){
  test(`${platform} cancellation during native import retains legacy and prepared-session call forms`,async()=>{
    for(const form of ['legacy','prepared','prepared-options'])await fixture(async({values,calls,entered,release,trackOpening})=>{
      const controller=new AbortController();
      // Chrome 96 has neither throwIfAborted nor reason; cancellation must not
      // depend on either property existing on the launch signal.
      const signal={get aborted(){return controller.signal.aborted;}};
      const sessionId=useServerStore.getState().sessionId;
      const args=form==='legacy'?[signal]:form==='prepared'?[{sessionId},signal]:[{sessionId,signal}];
      const opening=trackOpening(openEmbeddedReaderBook('/readest/reader',href=>calls.push(['router',href]),platform,...args));
      await entered;
      controller.abort();release();await opening;
      assert.deepEqual(calls,[]);
      assert.equal(window.name,'');assert.equal(values.size,0);
    });
  });

  test(`${platform} cancelled native import failure cannot route or arm a return`,()=>fixture(async({values,calls,entered,release,host,trackOpening})=>{
    const controller=new AbortController();
    const opening=trackOpening(openEmbeddedReaderBook('/readest/reader',href=>calls.push(['router',href]),platform,{sessionId:useServerStore.getState().sessionId},controller.signal));
    await entered;
    controller.abort();host.loadError=new Error('cancelled native module failure');
    release();await opening;
    assert.deepEqual(calls,[]);
    assert.equal(window.name,'');assert.equal(values.size,0);
  }));

  test(`${platform} native module loading rechecks disconnect and same-server identity changes before dispatching`,async()=>{
    const changes=['disconnect','setUser','logout',...(platform==='android'?['candidate']:[])];
    for(const change of changes)await fixture(async({values,calls,entered,release,trackOpening})=>{
      const opening=trackOpening(openEmbeddedReaderBook('/readest/reader',href=>calls.push(['router',href]),platform));
      await entered;
      assert.equal(window.name,'');assert.equal(values.size,0,'module resolution must precede preparation');
      const initialSessionId=useServerStore.getState().sessionId;
      if(change==='disconnect')useServerStore.getState().disconnect();
      else if(change==='setUser')useServerStore.getState().setUser({id:2,name:'Changed account'});
      else if(change==='logout')useServerStore.getState().logout();
      else useServerStore.setState({candidate:{id:'b',url:'http://b.test',requestId:1,needsAccessCode:false}});
      if(change==='setUser'||change==='logout'){
        assert.equal(useServerStore.getState().serverUrl,'http://a.test','identity changes keep the same server');
        assert.equal(useServerStore.getState().activeServerId,'a');
        assert.ok(useServerStore.getState().sessionId>initialSessionId,'identity changes invalidate the captured session');
      }
      release();
      await assert.rejects(opening,{code:'reader.context_changed'});
      assert.deepEqual(calls,[]);
      assert.equal(window.name,'');assert.equal(values.size,0);
    });
  });

  test(`${platform} native module load failure falls back without preparing a receipt`,()=>fixture(async({values,calls,entered,release,host,trackOpening})=>{
    const opening=trackOpening(openEmbeddedReaderBook('/readest/reader',href=>calls.push(['router',href]),platform));
    await entered;
    assert.equal(window.name,'');assert.equal(values.size,0);
    host.loadError=new Error('synthetic native module load failed');
    release();await opening;
    assert.deepEqual(calls,[['router','/readest/reader']]);
    assert.equal(window.name,'');assert.equal(values.size,0);
  }));
}
