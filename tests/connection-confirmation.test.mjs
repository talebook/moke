import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

// Run the real handlers with deferred checks/activation and React hook state.
// Cancellation deliberately does not settle these promises: identity fencing
// must protect a newer form even when its predecessor finishes afterwards.
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const mocks = new Map([
  ['react', `
    export const Suspense = Symbol('Suspense');
    export const useState = value => globalThis.__connectionHarness.useState(value);
    export const useRef = value => globalThis.__connectionHarness.useRef(value);
    export const useEffect = (...args) => globalThis.__connectionHarness.useEffect(...args);
  `],
  ['react/jsx-runtime', `export const Fragment = Symbol('Fragment');
    export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;`],
  ['next/navigation', `
    export const useRouter = () => globalThis.__connectionHarness.router;
    export const useSearchParams = () => new URLSearchParams(globalThis.__connectionHarness.params);
  `],
  ['zustand/react/shallow', 'export const useShallow = value => value;'],
  ['lucide-react', 'export const BookOpen = () => null; export const KeyRound = () => null;'],
  ['@/lib/store/server', `
    export const useServerStore = selector => selector ? selector(globalThis.__connectionHarness.state) : globalThis.__connectionHarness.state;
    useServerStore.getState = () => globalThis.__connectionHarness.state;
  `],
  ['@/lib/api', `
    export const submitWelcomeCode = (...args) => globalThis.__connectionHarness.verify(...args);
    export const getErrorMessage = (error, fallback) => error.message || fallback;
    export const checkWelcomeRequirement = () => {};
    export const validateServerConnection = () => {};
  `],
  ['@/lib/server-connection', 'export const checkSavedServer = (...args) => globalThis.__connectionHarness.check(...args);'],
  ['@/lib/reader-source', 'export const requireClosedReaders = async () => {};'],
  ['@/lib/server-url', 'export const normalizeServerAddress = value => value;'],
  ['@/lib/store/developer', 'export const useDeveloperStore = {getState:() => ({unlock:() => {}})};'],
  ['@/lib/clipboard', 'export const copyTextToClipboard = async () => true;'],
  ['@/lib/app-version', 'export const APP_VERSION = "test";'],
  ['@/components/auth/CaptchaModal', 'export const CaptchaModal = () => null;'],
]);
registerHooks({resolve(specifier, context, next) {
  if (mocks.has(specifier)) return {url:moduleUrl(mocks.get(specifier)),shortCircuit:true};
  return next(specifier, context);
}});
const compile = (path, extra = '') => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8') + extra, {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const {default:WelcomePage} = await import(moduleUrl(compile('../src/app/welcome/page.tsx')));
const {AccessPageInner} = await import(moduleUrl(compile('../src/app/access/page.tsx', '\nexport {AccessPageInner};')));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {resolve=done; reject=fail;});
  return {promise,resolve,reject};
}
function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(match(tree) ? [tree] : []), ...[tree.props?.children].flat(Infinity).flatMap(child => nodes(child, match))];
}
const text = tree => typeof tree === 'string' ? tree : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
function harness(kind, initialState = {}) {
  const slots = [], refs = [], effects = [], pendingEffects = [];
  let cursor=0, refCursor=0, effectCursor=0, requestNumber=1;
  const h = globalThis.__connectionHarness = {
    kind, routes:[], updates:[], checks:[], verifications:[], activations:[], connections:[], accessRequests:[], offlineCalls:0,
    params:'serverId=a&requestId=1', remountOnActivation:false,
    router:{push:path => h.routes.push(path),replace:path => h.routes.push(path)},
    state:{
      savedServers:[{id:'a',url:'https://a.test',title:'A'},{id:'b',url:'https://b.test',title:'B'}],
      candidate:kind === 'access' ? {id:'a',url:'https://a.test',requestId:1} : null,
      serverUrl:'https://current.test',activeServerId:'current',user:{id:9},token:'current-token',
      connectionId:1,sessionId:1,offlineMode:false,saving:false,hasHydrated:true,
      storageBusy:false,storageError:'',readerReturnError:'',serverListNotice:'',
      beginConnection:id => {
        h.connections.push(id);
        if (h.state.storageBusy || h.state.storageError) return null;
        const server=h.state.savedServers.find(server => server.id === id);
        h.state.candidate={...server,requestId:++requestNumber};
        return h.state.candidate;
      },
      cancelConnection:requestId => {
        if (requestId === undefined || h.state.candidate?.requestId === requestId) h.state.candidate=null;
      },
      requireAccess:requestId => h.accessRequests.push(requestId),
      activateCandidate:async requestId => {
        const activation={requestId,...deferred()}; h.activations.push(activation);
        const confirmed=await activation.promise;
        if (confirmed) {
          const candidate=h.state.candidate;
          Object.assign(h.state,{candidate:null,serverUrl:candidate.url,activeServerId:candidate.id,sessionId:h.state.sessionId+1});
          if (h.remountOnActivation) h.unmount();
        }
        return confirmed;
      },
      enterOfflineMode:async () => {
        h.offlineCalls++;
        if (h.offlineError) throw new Error(h.offlineError);
        h.state.offlineMode=true; h.state.hasHydrated=true;
      },
      disconnect:() => {}, loadServers:() => assert.fail('exit must not reload the document or registry'),
      recoverServers:() => assert.fail('exit must not race registry recovery'),saveServer:async () => {},
    },
    useState(initial) {
      const index=cursor++;
      if (!(index in slots)) slots[index]=initial;
      return [slots[index], value => {slots[index]=value; h.updates.push({index,value});}];
    },
    useRef(initial) {return refs[refCursor++] ??= {current:initial};},
    useEffect(effect, deps) {
      const index=effectCursor++;
      if (effects[index]?.deps.length === deps.length && effects[index].deps.every((value,i) => Object.is(value,deps[i]))) return;
      pendingEffects.push(() => {effects[index]?.cleanup?.(); effects[index]={deps,cleanup:effect()};});
    },
    check(url, checks, signal) {const check={url,signal,...deferred()};h.checks.push(check);return check.promise;},
    verify(code, captcha, url, signal) {const verify={code,captcha,url,signal,...deferred()};h.verifications.push(verify);return verify.promise;},
    render() {
      cursor=0; refCursor=0; effectCursor=0;
      const tree=(kind === 'access' ? AccessPageInner : WelcomePage)();
      for (const effect of pendingEffects.splice(0)) effect();
      return tree;
    },
    buttons(label) {return nodes(h.render(), node => node.type === 'button' && text(node) === label);},
    click(label) {const button=h.buttons(label)[0];assert.ok(button, `missing ${label}`);return button.props.onClick();},
    connect(id) {
      const row=nodes(h.render(), node => node.type === 'li').find(node => text(node).startsWith(id === 'a' ? 'A' : 'B'));
      return nodes(row, node => node.type === 'button')[0].props.onClick();
    },
    submit() {return nodes(h.render(), node => node.type === 'form')[0].props.onSubmit({preventDefault(){}});},
    fill() {
      nodes(h.render(), node => node.props?.placeholder === '请输入访问码')[0].props.onChange({target:{value:'fixture-code'}});
      h.render();
    },
    get status() {return kind === 'access' ? {loading:slots[1],error:slots[2],captcha:slots[3]} : {loading:slots[5],error:slots[3],notice:slots[4]};},
    unmount() {for (const effect of effects) effect.cleanup?.();},
    async close() {
      h.unmount();
      for (const request of h.checks) request.resolve({needsAccessCode:false});
      for (const request of h.verifications) request.resolve({err:'ok'});
      for (const request of h.activations) request.resolve(false);
      await nextTurn();
    },
  };
  Object.assign(h.state,initialState);
  h.render(); if (kind === 'access') h.fill(); return h;
}
async function reachActivation(h, id = 'a') {
  if (h.kind === 'access') {
    h.submit(); h.verifications.at(-1).resolve({err:'ok'});
  } else {h.connect(id); await nextTurn(); h.checks.at(-1).resolve({needsAccessCode:false});}
  await nextTurn();
  return h.activations.at(-1);
}

test('welcome reports a current failed confirmation, retains the list/account and permits retry', async () => {
  const h=harness('welcome');
  try {
    const before={list:h.state.savedServers,url:h.state.serverUrl,user:h.state.user};
    const activation=await reachActivation(h);activation.resolve(false);await nextTurn();
    assert.equal(h.status.error,'连接未被确认，请重试');assert.equal(h.status.loading,null);
    assert.deepEqual(h.routes,[]);assert.equal(h.state.savedServers,before.list);
    assert.equal(h.state.serverUrl,before.url);assert.equal(h.state.user,before.user);
    h.connect('a');await nextTurn();h.checks.at(-1).resolve({needsAccessCode:false});await nextTurn();
    assert.equal(h.status.error,'');h.activations.at(-1).resolve(true);await nextTurn();
    assert.deepEqual(h.routes,['/shelf']);
  } finally {await h.close();}
});

test('welcome cancellation suppresses a late false confirmation', async () => {
  const h=harness('welcome');
  try {
    const activation=await reachActivation(h);h.click('取消连接');
    const before=h.updates.length;activation.resolve(false);await nextTurn();
    assert.equal(h.updates.length,before);assert.equal(h.status.error,'');
    assert.match(h.status.notice,/连接已取消/);assert.deepEqual(h.routes,[]);
  } finally {await h.close();}
});

test('welcome old false confirmation cannot clear or add errors to a newer pending attempt', async () => {
  const h=harness('welcome');
  try {
    const old=await reachActivation(h);h.connect('b');await nextTurn();
    const current=h.checks.at(-1), before=h.updates.length;
    old.resolve(false);await nextTurn();
    assert.equal(h.updates.length,before);assert.equal(h.status.loading,'b');assert.equal(h.status.error,'');
    assert.equal(current.signal.aborted,false);
    current.resolve({needsAccessCode:false});await nextTurn();h.activations.at(-1).resolve(false);await nextTurn();
    assert.equal(h.status.error,'连接未被确认，请重试');
  } finally {await h.close();}
});

test('access reports failed activation and a retry completes even when its own session change unmounts it', async () => {
  const h=harness('access');
  try {
    const first=await reachActivation(h);first.resolve(false);await nextTurn();
    assert.deepEqual(h.status,{loading:false,error:'连接未被确认，请重试',captcha:false});
    assert.deepEqual(h.routes,[]);assert.equal(h.state.serverUrl,'https://current.test');
    h.submit();h.verifications.at(-1).resolve({err:'ok'});await nextTurn();
    h.remountOnActivation=true;h.activations.at(-1).resolve(true);await nextTurn();
    assert.equal(h.verifications.at(-1).signal.aborted,true);
    assert.deepEqual(h.routes,['/shelf'],'the activation-created cleanup must not prevent success navigation');
  } finally {await h.close();}
});

test('access explicit back suppresses a late false activation', async () => {
  const h=harness('access');
  try {
    const activation=await reachActivation(h);
    nodes(h.render(), node => node.type === 'button' && node.props['aria-label'] === '返回')[0].props.onClick();
    const before=h.updates.length;activation.resolve(false);await nextTurn();
    assert.equal(h.status.error,'');assert.deepEqual(h.routes,['/welcome']);
    assert.equal(h.updates.slice(before).some(update => update.value === '连接未被确认，请重试'),false);
  } finally {await h.close();}
});

test('cold access restoration waits for the registry reservation to clear after hydration', async () => {
  const h=harness('access',{candidate:null,serverUrl:'',hasHydrated:false,storageBusy:true});
  try {
    h.state.hasHydrated=true;h.render();
    assert.deepEqual(h.connections,[],'visible hydration must not consume restoration while busy');
    assert.equal(h.state.candidate,null);assert.deepEqual(h.routes,[]);
    h.state.storageBusy=false;h.render();
    assert.deepEqual(h.connections,['a']);assert.deepEqual(h.accessRequests,[2]);
    assert.equal(h.state.candidate.id,'a');assert.equal(h.state.candidate.requestId,2);
    assert.deepEqual(h.routes,['/access?serverId=a&requestId=2']);
    h.params='serverId=a&requestId=2';h.render();
    assert.equal(h.connections.length,1,'query correction must not create another candidate');
    assert.equal(nodes(h.render(),node => node.type === 'button' && node.props.type === 'submit')[0].props.disabled,false);
    assert.equal(h.verifications.length,0,'restoration does not submit an access code automatically');
  } finally {await h.close();}
});

test('cold access never reconstructs a candidate during a persistent registry timeout', async () => {
  const h=harness('access',{candidate:null,serverUrl:'',hasHydrated:false,storageBusy:true});
  try {
    Object.assign(h.state,{hasHydrated:true,storageError:'服务器列表读取超时'});h.render();h.render();
    assert.deepEqual(h.connections,[]);assert.deepEqual(h.accessRequests,[]);
    assert.equal(h.state.candidate,null);assert.deepEqual(h.routes,[]);
    assert.equal(nodes(h.render(),node => node.type === 'button' && node.props.type === 'submit')[0].props.disabled,true);
    assert.equal(h.verifications.length,0);
  } finally {await h.close();}
});

test('cold access read failure remains retryable after the error is cleared', async () => {
  const h=harness('access',{candidate:null,serverUrl:'',hasHydrated:true,storageError:'列表读取失败'});
  try {
    assert.deepEqual(h.connections,[]);
    h.state.storageError='';h.render();
    assert.deepEqual(h.connections,['a']);assert.deepEqual(h.routes,['/access?serverId=a&requestId=2']);
  } finally {await h.close();}
});

for (const outcome of ['false activation','error response','captcha response']) {
  test(`access context change fences old ${outcome} and its finally against the new form`, async () => {
    const h=harness('access');
    try {
      let old;
      if (outcome === 'false activation') old=await reachActivation(h);
      else {h.submit();old=h.verifications.at(-1);}
      const oldRequest=h.verifications[0];
      h.state.candidate={id:'b',url:'https://b.test',requestId:2};h.params='serverId=b&requestId=2';h.render();
      assert.equal(oldRequest.signal.aborted,true);
      assert.deepEqual(h.status,{loading:false,error:'',captcha:false});
      h.submit();const current=h.verifications.at(-1), before=h.updates.length;
      if (outcome === 'false activation') old.resolve(false);
      else if (outcome === 'error response') old.reject(new Error('old response failed'));
      else old.resolve({err:'captcha.required',msg:'old captcha'});
      await nextTurn();
      assert.equal(h.updates.length,before);assert.deepEqual(h.status,{loading:true,error:'',captcha:false});
      assert.equal(current.signal.aborted,false);assert.equal(current.url,'https://b.test');
      current.resolve({err:'ok'});await nextTurn();h.activations.at(-1).resolve(false);await nextTurn();
      assert.deepEqual(h.status,{loading:false,error:'连接未被确认，请重试',captcha:false});
    } finally {await h.close();}
  });
}

test('timeout error contains one actionable offline-library exit and preserves the storage lock', async () => {
  const h=harness('welcome');
  try {
    Object.assign(h.state,{storageBusy:true,storageError:'服务器列表读取超时',serverUrl:''});
    assert.equal(h.buttons('先使用离线书库').length,1);assert.equal(h.buttons('进入离线模式').length,0);
    assert.equal(h.buttons('重试加载').length,0);assert.equal(h.buttons('保留原数据并重建列表').length,0);
    h.click('先使用离线书库');await nextTurn();
    assert.deepEqual(h.routes,['/library']);assert.equal(h.offlineCalls,1);
    assert.equal(h.state.storageBusy,true);assert.equal(h.state.storageError,'服务器列表读取超时');
  } finally {await h.close();}
});

test('timeout return-to-current-shelf exit cancels a candidate and keeps the account/list', async () => {
  const h=harness('welcome');
  try {
    Object.assign(h.state,{storageBusy:true,storageError:'服务器列表读取超时',candidate:{id:'b',requestId:3}});
    const list=h.state.savedServers,user=h.state.user;
    assert.equal(h.buttons('返回当前书架').length,1);h.click('返回当前书架');
    assert.deepEqual(h.routes,['/shelf']);assert.equal(h.offlineCalls,0);
    assert.equal(h.state.savedServers,list);assert.equal(h.state.user,user);assert.equal(h.state.candidate,null);
    assert.equal(h.state.storageBusy,true);
  } finally {await h.close();}
});

test('a Reader boundary failure on offline exit is shown without navigating', async () => {
  const h=harness('welcome');
  try {
    Object.assign(h.state,{storageBusy:true,storageError:'服务器列表读取超时'});
    h.offlineError='请先关闭当前阅读器';h.click('先使用离线书库');await nextTurn();
    assert.equal(h.status.error,'请先关闭当前阅读器');assert.deepEqual(h.routes,[]);
    assert.equal(h.state.offlineMode,false);assert.equal(h.state.storageBusy,true);
  } finally {await h.close();}
});
