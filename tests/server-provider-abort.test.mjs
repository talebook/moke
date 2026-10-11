import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { DEFAULT_SERVER_CAPABILITIES } from '../src/lib/server-capabilities.ts';

// Execute the production provider's effects with synthetic React hooks. HTTP
// can deliberately ignore cancellation, exercising the provider's session and
// cleanup guards separately from the API's transport-level AbortSignal tests.
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const mocks = new Map([
  ['react', `
    export const Fragment = Symbol('Fragment');
    export const useEffect = (...args) => globalThis.__serverProviderAbortHarness.useEffect(...args);
    export const useRef = value => globalThis.__serverProviderAbortHarness.useRef(value);
  `],
  ['react/jsx-runtime', 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;'],
  ['next/navigation', `
    export const useRouter = () => globalThis.__serverProviderAbortHarness.router;
    export const usePathname = () => globalThis.__serverProviderAbortHarness.pathname;
  `],
  ['@/lib/store/server', `
    export const useServerStore = () => globalThis.__serverProviderAbortHarness.state;
    useServerStore.getState = useServerStore;
    useServerStore.setState = update => Object.assign(useServerStore(), update);
  `],
  ['@/lib/api', `
    const call = (kind, server, signal) => globalThis.__serverProviderAbortHarness.api(kind, server, signal);
    export const checkWelcomeRequirement = (...args) => call('welcome', ...args);
    export const fetchCurrentUser = (...args) => call('user', ...args);
    export const fetchServerInfo = (...args) => call('title', ...args);
    export const discoverServerCapabilities = (...args) => call('capabilities', ...args);
  `],
  ['@/lib/moke-reader', 'export const navigateFullDocument = () => { throw new Error("unexpected redirect"); };'],
]);
const realModules = new Map([
  ['@/lib/server-capabilities', new URL('../src/lib/server-capabilities.ts', import.meta.url).href],
  ['@/lib/server-session', new URL('../src/lib/server-session.ts', import.meta.url).href],
]);
registerHooks({ resolve(specifier, context, next) {
  if (mocks.has(specifier)) return {url:moduleUrl(mocks.get(specifier)),shortCircuit:true};
  if (realModules.has(specifier)) return next(realModules.get(specifier), context);
  return next(specifier, context);
} });
const compiled = ts.transpileModule(readFileSync(new URL('../src/components/providers/ServerProvider.tsx', import.meta.url), 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const { ServerProvider } = await import(moduleUrl(compiled));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const request = {settled:false};
  request.promise = new Promise((done, fail) => {
    resolve = done; reject = fail;
  });
  request.resolve = value => {request.settled = true; resolve(value);};
  request.reject = error => {request.settled = true; reject(error);};
  return request;
}

function createProvider({delayWelcome = false} = {}) {
  const refs = [], effects = [], pendingEffects = [];
  let refCursor = 0, effectCursor = 0;
  const h = globalThis.__serverProviderAbortHarness = {
    pathname:'/shelf', requests:[], updates:[], routes:[],
    router:{push:path => h.routes.push(path),replace:path => h.routes.push(path)},
    state:{
      serverUrl:'https://a.test',offlineMode:false,hasHydrated:true,readerReturnTo:null,
      connectionId:1,sessionId:1,user:{id:'a-user',name:'Original A'},
      capabilities:{...DEFAULT_SERVER_CAPABILITIES,annotationApiStatus:'supported',annotationApiCheckedAt:123},
      loadServers:() => assert.fail('an already hydrated provider must not load the registry'),
      cancelConnection:() => {},
      beginActiveAccessConfirmation:() => assert.fail('the fixture does not require access confirmation'),
      setServerTitle:async (title, source) => {h.updates.push({kind:'title',title,source});},
      setUser:user => {h.updates.push({kind:'user',user}); h.state.user = user;},
      setServerCapabilities:capabilities => {h.updates.push({kind:'capabilities',capabilities}); h.state.capabilities = capabilities;},
    },
    useRef(initial) {return refs[refCursor++] ??= {current:initial};},
    useEffect(effect, deps) {
      const index = effectCursor++;
      if (effects[index]?.deps.length === deps.length && effects[index].deps.every((value, i) => Object.is(value, deps[i]))) return;
      pendingEffects.push(() => {
        effects[index]?.cleanup?.();
        effects[index] = {deps,cleanup:effect()};
      });
    },
    api(kind, server, signal) {
      const request = Object.assign(deferred(), {kind,server,signal});
      h.requests.push(request);
      if (kind === 'welcome' && !delayWelcome) request.resolve({err:'ok',needsAccessCode:false});
      return request.promise;
    },
    render() {
      refCursor = 0; effectCursor = 0;
      const tree = ServerProvider({children:'fixture child'});
      for (const effect of pendingEffects.splice(0)) effect();
      return tree;
    },
    unmount() {for (const effect of effects) effect.cleanup?.();},
    finish(requests, outcome = 'resolve', label = 'late') {
      for (const request of requests.filter(request => !request.settled)) {
        if (outcome === 'reject') request.reject(new DOMException('fixture cancelled', 'AbortError'));
        else if (request.kind === 'welcome') request.resolve({err:'ok',needsAccessCode:false});
        else if (request.kind === 'user') request.resolve({err:'ok',isLogin:true,user:{id:`${label}-user`,name:label}});
        else if (request.kind === 'title') request.resolve({err:'ok',title:`${label} title`});
        else request.resolve({...DEFAULT_SERVER_CAPABILITIES,shelfApi:true,checkedAt:Date.now(),version:label});
      }
    },
  };
  return h;
}

function assertSharedSignal(requests) {
  assert.deepEqual(requests.map(request => request.kind), ['welcome','user','title','capabilities']);
  const signal = requests[0].signal;
  assert.ok(signal instanceof AbortSignal);
  for (const request of requests) {
    assert.equal(request.server, 'https://a.test');
    assert.equal(request.signal, signal, `${request.kind} must receive the provider's shared signal`);
  }
  return signal;
}

test('a current provider round shares its signal and commits user, title and capabilities', async () => {
  const h = createProvider();
  try {
    h.render();
    await nextTurn();
    const signal = assertSharedSignal(h.requests);
    assert.equal(signal.aborted, false);
    h.finish(h.requests, 'resolve', 'current');
    await nextTurn();
    assert.deepEqual(h.updates.map(update => update.kind), ['title','user','capabilities']);
    assert.deepEqual(h.updates[0], {kind:'title',title:'current title',source:{serverUrl:'https://a.test',connectionId:1,sessionId:1}});
    assert.equal(h.state.user.id, 'current-user');
    assert.equal(h.state.capabilities.version, 'current');
    assert.equal(h.state.capabilities.annotationApiStatus, 'supported');
    assert.equal(h.state.capabilities.annotationApiCheckedAt, 123);
    assert.deepEqual(h.routes, []);
  } finally {h.unmount(); h.finish(h.requests, 'reject'); await nextTurn();}
});

for (const change of ['unmount','session','connection']) {
  for (const outcome of ['resolve','reject']) {
    test(`${change} cleanup aborts all probes and ignores their late ${outcome} outcome`, async () => {
      const h = createProvider();
      try {
        h.render();
        await nextTurn();
        const old = [...h.requests], signal = assertSharedSignal(old);
        assert.equal(signal.aborted, false);
        if (change === 'unmount') h.unmount();
        else {
          h.state = {...h.state,sessionId:2,user:{id:'new-session',name:'Current user'}};
          if (change === 'connection') h.state = {...h.state,connectionId:2,serverUrl:'https://b.test'};
          h.render();
          await nextTurn();
          const current = h.requests.slice(old.length);
          assert.equal(current.length, 4);
          assert.notEqual(current[0].signal, signal);
          assert.equal(current[0].signal.aborted, false);
          assert.equal(current.at(-1).signal, current[0].signal);
        }
        assert.equal(signal.aborted, true);
        const before = h.state;
        h.finish(old, outcome);
        await nextTurn();
        assert.deepEqual(h.updates, [], 'an old round must not write user/title/capabilities');
        assert.equal(h.state, before);
        assert.deepEqual(h.routes, []);
      } finally {h.unmount(); h.finish(h.requests, 'reject'); await nextTurn();}
    });
  }
}

test('a same-server session change fences stale results before effect cleanup runs', async () => {
  const h = createProvider();
  try {
    h.render();
    await nextTurn();
    const old = [...h.requests], signal = assertSharedSignal(old);
    h.state = {...h.state,sessionId:2,user:{id:'new-session',name:'Current user'}};
    h.finish(old);
    await nextTurn();
    assert.equal(signal.aborted, false, 'the changed context must protect state even before cleanup');
    assert.deepEqual(h.updates, []);
    assert.equal(h.state.user.id, 'new-session');
    h.render();
    assert.equal(signal.aborted, true);
    await nextTurn();
  } finally {h.unmount(); h.finish(h.requests, 'reject'); await nextTurn();}
});

test('cleanup while welcome is pending prevents the capability fan-out and access redirects', async () => {
  const h = createProvider({delayWelcome:true});
  try {
    h.render();
    assert.equal(h.requests.length, 1);
    const welcome = h.requests[0];
    h.unmount();
    assert.equal(welcome.signal.aborted, true);
    welcome.resolve({err:'ok',needsAccessCode:true});
    await nextTurn();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.updates, []);
    assert.deepEqual(h.routes, []);
  } finally {h.unmount(); h.finish(h.requests, 'reject'); await nextTurn();}
});
