import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

const host = globalThis.__continueReadingSession = {};
const modules = new Map([
  ['react', `export const useRef = value => ({current:value});
    export const useEffect = effect => globalThis.__continueReadingSession.effects.push(effect);`],
  ['react/jsx-runtime', 'export const Fragment = Symbol(); export const jsx = () => null;'],
  ['next/navigation', 'export const useRouter = () => globalThis.__continueReadingSession.router;'],
  ['@/lib/api', 'export const request = () => {};'],
  ['@/lib/toast', `export const useToast = {getState:()=>({show:message=>globalThis.__continueReadingSession.toasts.push(message)})};`],
  ['@/lib/store/server', `const host=globalThis.__continueReadingSession;
    export const useServerStore={getState:()=>host.state,subscribe:listener=>{host.listeners.add(listener);return()=>host.listeners.delete(listener);}};`],
  ['@/lib/continue-reading', `const host=globalThis.__continueReadingSession;
    export const CONTINUE_READING_CHANGED_EVENT='moke:continue-reading-changed';
    export const CONTINUE_READING_NATIVE_EVENT='moke:continue-reading-request';
    export const getContinueReading=()=>host.local;
    export const fetchContinueReadingFromHistory=(_request,source,signal)=>host.fetch(source,signal);
    export const rememberContinueReading=entry=>{host.remembered.push({...entry});host.local=entry;};
    export const continueReadingHref=entry=>'/detail?id='+entry.bookId+'&continue=1';`],
]);
registerHooks({ resolve(specifier, context, next) {
  if (modules.has(specifier)) return { shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(modules.get(specifier)) };
  return next(specifier,context);
} });
const source = readFileSync(new URL('../src/components/providers/ContinueReadingLauncher.tsx',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const { ContinueReadingLauncher } = await import('data:text/javascript,'+encodeURIComponent(compiled));
const nextTurn = () => new Promise(resolve=>setImmediate(resolve));
const entry = (serverUrl='https://a.test',bookId='42') => ({serverUrl,mode:'online',bookId,updatedAt:1});
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function fixture(context,{startup=false,local=null}={}) {
  const previousWindow=globalThis.window;
  Object.assign(host,{effects:[],listeners:new Set(),routes:[],toasts:[],remembered:[],local,fetches:[],
    state:{serverUrl:'https://a.test',connectionId:1,sessionId:1,offlineMode:false,candidate:null,hasHydrated:true}});
  host.router={push:route=>host.routes.push(route)};
  const gate=deferred();
  host.fetch=(serverUrl,signal)=>{host.fetches.push({serverUrl,signal});return gate.promise;};
  const window=new EventTarget();
  Object.assign(window,{setTimeout,clearTimeout,MokeWindowMode:{
    setContinueReadingShortcutEnabled(){},
    consumeContinueReadingLaunch(){const pending=startup;startup=false;return pending;},
  }});
  globalThis.window=window;
  ContinueReadingLauncher({children:null});
  const cleanups=host.effects.map(effect=>effect());
  const cleanup=()=>{for(const clean of cleanups)clean();};
  context.after(async()=>{cleanup();gate.resolve(null);await nextTurn();globalThis.window=previousWindow;});
  return {
    gate,cleanup,
    launch:()=>window.dispatchEvent(new Event('moke:continue-reading-request')),
    change:update=>{host.state={...host.state,...update};for(const notify of host.listeners)notify();},
  };
}

for(const changed of ['connection','identity','source','offline mode','candidate']) {
  for(const outcome of ['resolve','reject']) {
    test(`late shortcut history ${outcome} after ${changed} changes cannot persist, navigate or misreport`,async context=>{
      const {gate,launch,change}=fixture(context);
      launch();
      assert.equal(host.fetches.length,1);
      const update={connection:{connectionId:2},identity:{sessionId:2},source:{serverUrl:'https://b.test'},
        'offline mode':{offlineMode:true},candidate:{candidate:{id:'b',requestId:1}}}[changed];
      change(update);
      assert.equal(host.fetches[0].signal.aborted,true);
      if(outcome==='resolve')gate.resolve(entry());else gate.reject(new Error('obsolete history failure'));
      await nextTurn();
      assert.deepEqual(host.routes,[]);
      assert.deepEqual(host.toasts,[]);
      assert.deepEqual(host.remembered,[]);
    });
  }
}

test('normal shortcut history remembers and opens once, while the startup bridge keeps its explicit entry',async context=>{
  const {gate,launch}=fixture(context,{startup:true});
  assert.equal(host.fetches.length,1,'startup consumes the native request and starts its lookup');
  launch();
  assert.equal(host.fetches.length,1,'repeated requests share the active opening reservation');
  gate.resolve(entry());await nextTurn();
  assert.deepEqual(host.routes,['/detail?id=42&continue=1']);
  assert.deepEqual(host.remembered,[entry()]);
  assert.deepEqual(host.toasts,[]);
});

test('cleanup aborts active history and ignores a late result',async context=>{
  const {gate,launch,cleanup}=fixture(context);
  launch();cleanup();
  assert.equal(host.fetches[0].signal.aborted,true);
  gate.resolve(entry());await nextTurn();
  assert.deepEqual(host.routes,[]);assert.deepEqual(host.remembered,[]);assert.deepEqual(host.toasts,[]);
});

test('an obsolete lookup cannot clear a newer opening reservation or consume its result',async context=>{
  const {launch,change}=fixture(context);
  const a=deferred(),b=deferred();
  host.fetch=(serverUrl,signal)=>{host.fetches.push({serverUrl,signal});return serverUrl==='https://a.test'?a.promise:b.promise;};
  launch();change({serverUrl:'https://b.test',connectionId:2,sessionId:2});launch();
  assert.equal(host.fetches.length,2);
  a.resolve(entry());await nextTurn();launch();
  assert.equal(host.fetches.length,2,'old completion must not release the new reservation');
  assert.deepEqual(host.routes,[]);
  b.resolve(entry('https://b.test','84'));await nextTurn();
  assert.deepEqual(host.routes,['/detail?id=84&continue=1']);
  assert.deepEqual(host.remembered,[entry('https://b.test','84')]);
});

test('a current history failure still reports the recoverable shelf fallback',async context=>{
  const {gate,launch}=fixture(context);
  launch();gate.reject(new Error('current history failure'));await nextTurn();
  assert.deepEqual(host.routes,['/shelf']);
  assert.deepEqual(host.toasts,['暂时无法读取最近阅读记录']);
});
