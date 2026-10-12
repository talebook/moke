import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

// Render the production Welcome handlers with synthetic hooks. Repository
// byte verification is tested separately; this suite checks the read-only UI.
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const mocks = new Map([
  ['@/lib/abort-signal', `export { throwIfAborted } from '${new URL('../src/lib/abort-signal.ts', import.meta.url).href}';`],
  ['react', `export const useState = value => globalThis.__backupView.useState(value);
    export const useRef = value => globalThis.__backupView.useRef(value);
    export const useEffect = (...args) => globalThis.__backupView.useEffect(...args);`],
  ['react/jsx-runtime', 'export const Fragment = Symbol("Fragment"); export const jsx = (type, props) => ({type,props}); export const jsxs = jsx;'],
  ['next/navigation', 'export const useRouter = () => globalThis.__backupView.router;'],
  ['zustand/react/shallow', 'export const useShallow = value => value;'],
  ['lucide-react', 'export const BookOpen = () => null;'],
  ['@/lib/store/server', `export const useServerStore = selector => selector(globalThis.__backupView.state);
    useServerStore.getState = () => globalThis.__backupView.state;`],
  ['@/lib/api', 'export const checkWelcomeRequirement = () => {}; export const validateServerConnection = () => {};'],
  ['@/lib/server-connection', 'export const checkSavedServer = () => {};'],
  ['@/lib/reader-source', 'export const requireClosedReaders = () => {};'],
  ['@/lib/server-url', 'export const normalizeServerAddress = value => value;'],
  ['@/lib/store/developer', 'export const useDeveloperStore = {};'],
  ['@/lib/clipboard', 'export const copyTextToClipboard = () => {};'],
  ['@/lib/app-version', 'export const APP_VERSION = "fixture";'],
]);
registerHooks({resolve(specifier, context, next) {
  return mocks.has(specifier) ? {url:moduleUrl(mocks.get(specifier)),shortCircuit:true} : next(specifier,context);
}});
const compiled = ts.transpileModule(readFileSync(new URL('../src/app/welcome/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const {default:WelcomePage} = await import(moduleUrl(compiled));
const key = 'moke-server-storage-damaged-backup-fixture';
const raw = '{"original":"invalid registry bytes preserved"}';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(match(tree) ? [tree] : []), ...[tree.props?.children].flat(Infinity).flatMap(child => nodes(child,match))];
}
const text = tree => typeof tree === 'string' ? tree : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
function harness() {
  const slots=[],refs=[],effects=[];let cursor=0,refCursor=0,effectCursor=0,resolve,reject;
  const h=globalThis.__backupView={
    reads:0,routes:[],router:{push:path => h.routes.push(path),replace:path => h.routes.push(path)},
    state:{savedServers:[],saving:false,storageBusy:false,storageError:'',hasHydrated:true,
      serverUrl:'https://active.example.test',activeServerId:'active',offlineMode:false,user:{id:1},sessionId:4,
      serverBackupKey:key,readServerBackup:() => {h.reads++;return new Promise((done,fail) => {resolve=done;reject=fail;});},
      beginConnection:() => assert.fail('backup viewing must not start a connection'),
      cancelConnection:() => assert.fail('backup viewing must not cancel a connection'),
      saveServer:() => assert.fail('backup viewing must not save'),
      recoverServers:() => assert.fail('backup viewing must not recover'),
      loadServers:() => assert.fail('backup viewing must not reload'),
    },
    useState(initial) {const index=cursor++;if (!(index in slots))slots[index]=initial;return [slots[index],value => {slots[index]=value;}];},
    useRef(initial) {return refs[refCursor++] ??= {current:initial};},
    useEffect(effect,deps) {
      const index=effectCursor++;
      if (effects[index]?.deps.length === deps.length && effects[index].deps.every((value,i) => Object.is(value,deps[i]))) return;
      effects[index]?.cleanup?.();effects[index]={deps,cleanup:effect()};
    },
    render() {cursor=0;refCursor=0;effectCursor=0;return WelcomePage();},
    button() {return nodes(h.render(),node => node.type === 'button' && /本次会话最新备份|正在读取备份/.test(text(node)))[0];},
    finish(result={ok:true,value:{key,raw}}) {resolve(result);},
    fail() {reject(new Error('unexpected storage error'));},
    get content() {return nodes(h.render(),node => node.type === 'textarea');},
    get errors() {return nodes(h.render(),node => node.props?.role === 'alert').map(text).join('');},
    async close() {for(const effect of effects)effect.cleanup?.();resolve?.({ok:false,error:'closed'});await nextTurn();},
  };
  h.render();return h;
}

for (const platform of ['tauri','web']) {
  test(`backup viewing shows verified bytes read-only with the concrete ${platform} location`, async context => {
    const previous=process.env.NEXT_PUBLIC_APP_PLATFORM;
    process.env.NEXT_PUBLIC_APP_PLATFORM=platform;
    context.after(() => {if(previous===undefined)delete process.env.NEXT_PUBLIC_APP_PLATFORM;else process.env.NEXT_PUBLIC_APP_PLATFORM=previous;});
    const h=harness();
    try {
      const before={...h.state};
      h.button().props.onClick();assert.equal(h.reads,1);assert.equal(h.button().props.disabled,true);
      h.finish();await nextTurn();
      assert.equal(h.content.length,1);assert.equal(h.content[0].props.readOnly,true);assert.equal(h.content[0].props.value,raw);
      assert.match(text(h.render()),platform==='tauri' ? new RegExp(`AppData/books/.servers/${key}\\.json`) : new RegExp(`当前站点 localStorage 键：${key}`));
      assert.deepEqual(h.state,before);assert.deepEqual(h.routes,[]);assert.equal(h.errors,'');
    } finally {await h.close();}
  });
}

for (const reason of ['storageBusy','saving']) {
  test(`backup viewing rejects a stale click during ${reason} before reading or mutating the store`, async () => {
    const h=harness();
    try {
      const click=h.button().props.onClick;h.state[reason]=true;const before={...h.state};
      assert.equal(h.button().props.disabled,true);click();await nextTurn();
      assert.equal(h.reads,0);assert.match(h.errors,/等待.*完成/);assert.equal(h.content.length,0);
      assert.deepEqual(h.state,before);assert.deepEqual(h.routes,[]);
    } finally {await h.close();}
  });
}

test('backup viewing displays a read failure without presenting unverified bytes and can retry', async () => {
  const h=harness();
  try {
    const before={...h.state};h.button().props.onClick();
    h.finish({ok:false,error:'备份已被修改，请保留原数据并重试。'});await nextTurn();
    assert.match(h.errors,/备份已被修改/);assert.equal(h.content.length,0);assert.equal(h.button().props.disabled,false);
    assert.deepEqual(h.state,before);
    h.button().props.onClick();h.finish();await nextTurn();
    assert.equal(h.reads,2);assert.equal(h.errors,'');assert.equal(h.content[0].props.value,raw);
  } finally {await h.close();}
});

test('backup viewing ignores duplicate clicks and cannot label a late older read as the latest backup', async () => {
  const h=harness();
  try {
    const click=h.button().props.onClick;click();click();assert.equal(h.reads,1);
    h.state.serverBackupKey='moke-server-storage-backup-newer';
    h.finish();await nextTurn();
    assert.equal(h.content.length,0);assert.match(h.errors,/备份已更新/);assert.equal(h.button().props.disabled,false);
  } finally {await h.close();}
});

test('backup viewing hides the session-only entry when absent and reports an unexpected storage failure', async () => {
  const h=harness();
  try {
    const click=h.button().props.onClick;h.state.serverBackupKey=null;
    assert.equal(h.button(),undefined);click();await nextTurn();
    assert.equal(h.reads,0);assert.match(h.errors,/尚无可查看/);
    h.state.serverBackupKey=key;h.button().props.onClick();h.fail();await nextTurn();
    assert.match(h.errors,/无法读取备份.*存储权限/);assert.equal(h.content.length,0);
  } finally {await h.close();}
});
