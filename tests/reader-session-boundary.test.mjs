import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the production store/Reader adapter with a synthetic IPC host. No
// window/native EPUB claim is made by these tests.
const host=globalThis.__readerSessionHost={labels:[],onOpen:async()=>{}};
const stub=source=>'data:text/javascript,'+encodeURIComponent(source);
registerHooks({resolve(specifier,context,next){
  if(specifier==='@tauri-apps/api/window')return {url:stub('export async function getAllWindows(){return globalThis.__readerSessionHost.labels.map(label=>({label}));}'),shortCircuit:true};
  if(specifier==='@tauri-apps/api/core')return {url:stub('export async function invoke(){await globalThis.__readerSessionHost.onOpen();}'),shortCircuit:true};
  return next(specifier,context);
}});
const { useServerStore }=await import('../src/lib/store/server.ts');
const { openReaderFromSource, requireClosedReaders, withClosedReaderSession, registerReaderProgressFlush }=await import('../src/lib/reader-source.ts');

function snapshot(){const s=useServerStore.getState();return {serverUrl:s.serverUrl,offlineMode:s.offlineMode,sessionId:s.sessionId,connectionId:s.connectionId};}
async function inTauri(run){const old=process.env.NEXT_PUBLIC_APP_PLATFORM;process.env.NEXT_PUBLIC_APP_PLATFORM='tauri';try{await run();}finally{host.labels=[];host.onOpen=async()=>{};if(old===undefined)delete process.env.NEXT_PUBLIC_APP_PLATFORM;else process.env.NEXT_PUBLIC_APP_PLATFORM=old;useServerStore.getState().disconnect();}}

test('settings offline transition rejects an open Reader and preserves origin/session/navigation',()=>inTauri(async()=>{
  useServerStore.getState().setServer('http','a.test','');
  const before=snapshot();
  let pathname='/settings';
  host.labels=['reader-900'];
  await assert.rejects(async()=>{await useServerStore.getState().enterOfflineMode();pathname='/shelf';},/请先关闭/);
  assert.deepEqual(snapshot(),before);
  assert.equal(pathname,'/settings');
  host.labels=[];
  let flushes=0;
  const remove=registerReaderProgressFlush(async()=>{flushes++;});
  try{await useServerStore.getState().enterOfflineMode();pathname='/shelf';}finally{remove();}
  assert.equal(flushes,1);
  assert.equal(pathname,'/shelf');
  assert.equal(useServerStore.getState().offlineMode,true);
  assert.equal(useServerStore.getState().sessionId,before.sessionId+1);
}));

test('opening Reader and in-flight authentication both reject offline before state/navigation changes',()=>inTauri(async()=>{
  useServerStore.getState().setServer('http','a.test','');
  const before=snapshot();
  let started,release;
  const entered=new Promise(resolve=>{started=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  host.onOpen=async()=>{started();await wait;host.labels=['reader-901'];};
  const opening=openReaderFromSource({serverUrl:before.serverUrl,bookId:'42',sessionId:before.sessionId},{});
  await entered;
  await assert.rejects(useServerStore.getState().enterOfflineMode(),/状态正在变更/);
  assert.deepEqual(snapshot(),before);
  release();await opening;
  host.labels=[];await requireClosedReaders();
  let authStarted,authRelease;
  const authEntered=new Promise(resolve=>{authStarted=resolve;});
  const authWait=new Promise(resolve=>{authRelease=resolve;});
  const auth=withClosedReaderSession(async()=>{authStarted();await authWait;});
  await authEntered;
  await assert.rejects(useServerStore.getState().enterOfflineMode(),/状态正在变更/);
  assert.deepEqual(snapshot(),before);
  authRelease();await auth;
  await useServerStore.getState().enterOfflineMode();
  assert.equal(useServerStore.getState().offlineMode,true);
}));

test('offline waits for flush under a reservation, rejects a racing open and does not change state on flush failure',()=>inTauri(async()=>{
  useServerStore.getState().setServer('http','a.test','');
  const before=snapshot();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  const remove=registerReaderProgressFlush(async()=>{started();await wait;throw new Error('flush failed');});
  try{
    const entering=useServerStore.getState().enterOfflineMode();
    await entered;
    assert.deepEqual(snapshot(),before);
    await assert.rejects(openReaderFromSource({serverUrl:before.serverUrl,bookId:'42',sessionId:before.sessionId},{}),/状态正在变更/);
    release();
    await assert.rejects(entering,/flush failed/);
    assert.deepEqual(snapshot(),before);
  }finally{remove();release();}
  await useServerStore.getState().enterOfflineMode();
  assert.equal(useServerStore.getState().offlineMode,true);
}));
