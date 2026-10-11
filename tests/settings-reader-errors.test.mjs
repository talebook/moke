import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { createReaderSourceBoundary } from '../src/lib/reader-source.ts';

// Execute the production Settings action handlers with the real typed Reader
// boundary. Synthetic hooks avoid DOM requirements; no native service runs.
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const icons = ['ArrowRight','BookOpen','Copy','Download','FolderOpen','LogOut','Moon','Package','Palette','PlugZap','RefreshCw','Settings2','ShieldAlert','ShieldCheck','Sun','User','Code2','MonitorCog'];
const mocks = new Map([
  ['react', 'export const useState = value => [value, () => {}]; export const useRef = value => ({current:value}); export const useEffect = () => {};'],
  ['react/jsx-runtime', 'export const Fragment = Symbol("Fragment"); export const jsx = (type, props) => ({type,props}); export const jsxs = jsx;'],
  ['next/link', 'export default function Link() {}'],
  ['next/navigation', 'export const useRouter = () => globalThis.__settingsReaderErrors.router;'],
  ['lucide-react', icons.map(name => `export const ${name} = () => null;`).join('\n')],
  ['@/components/layout/DesktopLayout', 'export const DesktopLayout = () => null;'],
  ['@/lib/store/server', `export const useServerStore = () => globalThis.__settingsReaderErrors.state;
    useServerStore.getState = useServerStore;`],
  ['@/lib/reader-source', `export const requireClosedReaders = () => globalThis.__settingsReaderErrors.boundary.requireClosedReaders();
    export const withClosedReaderSession = change => globalThis.__settingsReaderErrors.boundary.withClosedReaderSession(change);`],
  ['@/lib/api', `export {getErrorMessage, MokeApiError} from '${new URL('../src/lib/api-core.ts', import.meta.url).href}';
    export const fetchServerInfo = async () => ({});
    export const request = async (...args) => {globalThis.__settingsReaderErrors.requests.push(args);return new Response();};`],
  ['@/lib/store/developer', 'export const useDeveloperStore = selector => selector({unlocked:false,enabled:false});'],
  ['@/lib/store/settings', `export const useSettingsStore = selector => selector({downloadDirectory:null,readerPreference:'embedded'});
    export const resolveTheme = value => value;`],
  ['@/lib/store/update', 'export const useUpdateStore = selector => selector({});'],
  ['@/lib/utils', 'export const cn = (...values) => values.join(" ");'],
  ['@/lib/app-version', 'export const APP_VERSION = "fixture";'],
  ['@/lib/moke-reader', 'export const getMokeRuntimePlatform = async () => "web";'],
  ['@/lib/browser-storage', 'export const safeRemoveLocalStorageItem = key => globalThis.__settingsReaderErrors.removals.push(key);'],
  ['@/lib/toast', 'export const useToast = selector => selector({show:(...args) => globalThis.__settingsReaderErrors.toasts.push(args)});'],
  ['@/components/ui/Select', 'export const Select = () => null;'],
]);
registerHooks({resolve(specifier, context, next) {
  if (mocks.has(specifier)) return {url:moduleUrl(mocks.get(specifier)),shortCircuit:true};
  return next(specifier, context);
}});
const compiled = ts.transpileModule(readFileSync(new URL('../src/app/settings/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const {default:SettingsPage} = await import(moduleUrl(compiled));

function findAction(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.label === label && node.props.onClick) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const action = findAction(child, label); if (action) return action;
  }
  return null;
}
function harness(context, mode) {
  const previousWindow = globalThis.window;
  globalThis.window = {alert:() => assert.fail('settings errors must not open a blocking dialog')};
  context.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const h = globalThis.__settingsReaderErrors = {
    changes:[],routes:[],toasts:[],requests:[],removals:[],
    router:{push:path => h.routes.push(path)},
    state:{serverUrl:'https://a.test',serverTitle:'A',offlineMode:false,user:{id:1,name:'A'},connectionId:1,sessionId:1,
      disconnect:() => h.changes.push('disconnect'),logout:() => h.changes.push('logout'),
      enterOfflineMode:() => h.boundary.withClosedReaderSession(async () => {h.changes.push('offline');}),
    },
    boundary:createReaderSourceBoundary({
      getWindowLabels:async () => {
        if (mode === 'unknown') throw new Error('internal transport SECRET');
        return mode === 'reader' ? ['reader-1'] : [];
      },
      getContext:async () => h.state,open:async () => {},wait:async () => {},now:() => 0,
    }),
    click(label) {const action=findAction(SettingsPage(), label);assert.ok(action);return action.props.onClick();},
  };
  return h;
}
const actions = [
  ['断开连接','disconnect','/welcome','无法断开连接，请重试。'],
  ['退出登录','logout','/login','退出登录失败，请重试。'],
  ['进入离线模式','offline','/shelf','无法进入离线模式，请重试。'],
];
for (const [label, change, route, fallback] of actions) {
  test(`${label} reports the typed Reader guard through the existing error toast without changing context`, async context => {
    const h = harness(context, 'reader');
    await h.click(label);
    assert.deepEqual(h.toasts, [[`请先关闭当前阅读器及阅读器书库窗口，再${label}。当前连接已保留。`,'error']]);
    assert.deepEqual(h.changes, []); assert.deepEqual(h.routes, []);
    assert.deepEqual(h.requests, []); assert.deepEqual(h.removals, []);
  });
  test(`${label} hides unknown internal errors behind its actionable toast fallback`, async context => {
    const h = harness(context, 'unknown');
    await h.click(label);
    assert.deepEqual(h.toasts, [[fallback,'error']]);
    assert.doesNotMatch(JSON.stringify(h.toasts), /internal|SECRET/);
    assert.deepEqual(h.changes, []); assert.deepEqual(h.routes, []);
  });
  test(`${label} still completes when the Reader boundary is clear`, async context => {
    const h = harness(context, 'clear');
    await h.click(label);
    assert.deepEqual(h.toasts, []); assert.deepEqual(h.changes, [change]);
    assert.deepEqual(h.routes, [route]);
    assert.deepEqual(h.removals, change === 'offline' ? [] : ['moke-auth-token']);
    assert.equal(h.requests.length, change === 'logout' ? 1 : 0);
  });
}
