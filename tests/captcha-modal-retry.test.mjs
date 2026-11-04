import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as captchaCore from '../src/lib/captcha-core.ts';

const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Run the actual component handlers/effects. Browser focus and native IPC are
// verified separately; this host only checks attempts and callback lifetimes.
function modalHarness(onSuccess, provider = 'image') {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  globalThis.document = { activeElement: null };
  const hooks = [];
  let cursor = 0;
  let effects = [];
  let open = true;
  let closeCalls = 0;
  const frameWindow = {};
  const element = (type, props) => ({ type, props: props ?? {} });
  const react = {
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useId() { const index = cursor++; return `test-id-${index}`; },
    useState(initial) {
      const slot = hooks[cursor++] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!hooks[index] || dependencies.some((value, i) => !Object.is(value, hooks[index].dependencies[i]))) {
        hooks[index] = { dependencies, callback };
      }
      return hooks[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        hooks[index] = { dependencies, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = callback(); });
      }
    },
  };
  const requestCaptcha = async (url) => new Response(JSON.stringify(url.endsWith('/config')
    ? { err: 'ok', config: { provider, html: '<button>fixture</button>' } }
    : { err: 'ok', image: 'data:image/png;base64,AA==' }));
  const code = ts.transpileModule(readFileSync(new URL('../src/components/auth/CaptchaModal.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const modules = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'lucide-react': { X: 'test-icon', RefreshCw: 'test-icon' },
    '@/lib/api': { request: requestCaptcha },
    '@/lib/api-core': { cancelResponseBodyQuietly: async () => {} },
    '@/lib/native-connection': { nativeConnectionErrorMessage: (_error, fallback) => fallback },
    '@/lib/captcha-core': captchaCore,
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    assert.ok(id in modules, `unexpected dependency ${id}`);
    return modules[id];
  }, compiled, compiled.exports);
  const find = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return undefined;
    if (predicate(tree)) return tree;
    const children = [tree.props?.children].flat(Infinity);
    for (const child of children) { const found = find(child, predicate); if (found) return found; }
  };
  let tree;
  const render = () => {
    cursor = 0;
    tree = compiled.exports.CaptchaModal({ isOpen: open, serverUrl: 'http://fixture.invalid', requestCaptcha,
      onClose() { closeCalls++; }, onSuccess });
    const frame = find(tree, (node) => node.type === 'iframe');
    if (frame) frame.props.ref.current = { contentWindow: frameWindow };
    const queued = effects; effects = []; queued.forEach((run) => run());
    return tree;
  };
  return {
    async ready() { for (let i = 0; i < 5; i++) { render(); await flush(); } },
    render,
    input(value) { find(render(), (node) => node.type === 'input').props.onChange({ target: { value } }); render(); },
    submit() { return find(render(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    captureSubmit() { return find(render(), (node) => node.type === 'form').props.onSubmit; },
    refresh() { return find(render(), (node) => node.type === 'button' && node.props.title === '刷新验证码').props.onClick(); },
    fallback() { return find(render(), (node) => node.type === 'button' && node.props.children === '我已完成验证').props.onClick(); },
    refreshProvider() { return find(render(), (node) => node.type === 'button' && node.props.children === '刷新验证码').props.onClick(); },
    channel() { return JSON.parse(find(render(), (node) => node.type === 'iframe').props.srcDoc.match(/const channel = ("[^"]+");/)[1]); },
    message(channel, payload) { listeners.get('message')?.({ origin: 'null', source: frameWindow,
      data: { kind: 'moke-captcha-sandbox-v1', channel, type: 'success', payload } }); },
    escape() { find(render(), (node) => node.type === 'dialog').props.onCancel({ preventDefault() {} }); },
    get closeCalls() { return closeCalls; },
    get closeButton() { return find(render(), (node) => node.type === 'button' && node.props['aria-label'] === '关闭安全验证'); },
    close() { open = false; render(); },
    reopen() { open = true; render(); },
    dispose() { hooks.forEach((slot) => slot?.cleanup?.()); globalThis.window = previousWindow; globalThis.document = previousDocument; },
  };
}

test('same image modal accepts a corrected human attempt and a refreshed challenge after rejection', async () => {
  const calls = [];
  const h = modalHarness(async (value) => { calls.push(value); });
  try {
    await h.ready();
    h.input('wrong'); h.submit(); await flush();
    h.input('corrected'); h.submit(); await flush();
    assert.deepEqual(calls, ['wrong', 'corrected']);
    await h.refresh(); await h.ready();
    h.input('new-challenge'); h.submit(); await flush();
    assert.deepEqual(calls, ['wrong', 'corrected', 'new-challenge']);
  } finally { h.dispose(); }
});

test('same-challenge duplicate submission stays deduplicated and editing during flight cannot arm a retry', async () => {
  const pending = deferred();
  const calls = [];
  const h = modalHarness((value) => { calls.push(value); return pending.promise; });
  try {
    await h.ready();
    h.input('first'); h.submit(); h.submit();
    h.input('too-early'); h.submit();
    assert.deepEqual(calls, ['first']);
    pending.resolve(); await flush();
    h.submit(); assert.deepEqual(calls, ['first']);
    h.input('after-completion'); h.submit(); await flush();
    assert.deepEqual(calls, ['first', 'after-completion']);
  } finally { h.dispose(); }
});

test('third-party duplicate callback remains consumed after parent completion until a new challenge', async () => {
  const calls = [];
  const h = modalHarness(async (value) => { calls.push(value); }, 'webcode');
  try {
    await h.ready();
    h.fallback(); h.fallback(); await flush(); h.fallback();
    assert.equal(calls.length, 1);
  } finally { h.dispose(); }
});

test('refresh retires the old sandbox callback before configuration completes and accepts only its replacement', async () => {
  const calls = [];
  const h = modalHarness(async (value) => { calls.push(value); }, 'webcode');
  try {
    await h.ready();
    const oldChannel = h.channel();
    h.message(oldChannel, 'first'); h.message(oldChannel, 'duplicate'); await flush();
    assert.deepEqual(calls, ['first']);
    const refreshing = h.refreshProvider();
    h.message(oldChannel, 'queued-after-refresh');
    h.message('', 'empty-channel');
    assert.deepEqual(calls, ['first']);
    await refreshing; await h.ready();
    const newChannel = h.channel();
    assert.notEqual(newChannel, oldChannel);
    h.message(oldChannel, 'late-old-frame');
    h.message(newChannel, 'new-human-challenge'); await flush();
    assert.deepEqual(calls, ['first', 'new-human-challenge']);
  } finally { h.dispose(); }
});

test('a captured image submit from the previous challenge cannot submit after refresh', async () => {
  const calls = [];
  const h = modalHarness(async (value) => { calls.push(value); });
  try {
    await h.ready(); h.input('old-image'); const staleSubmit = h.captureSubmit();
    await h.refresh(); await h.ready();
    staleSubmit({ preventDefault() {} }); await flush();
    assert.deepEqual(calls, []);
    h.input('fresh-image'); h.submit(); await flush();
    assert.deepEqual(calls, ['fresh-image']);
  } finally { h.dispose(); }
});

test('late completion from a closed modal cannot unlock a newer submission; close and Escape respect its lock', async () => {
  const oldAttempt = deferred();
  const newAttempt = deferred();
  const calls = [];
  const h = modalHarness((value) => { calls.push(value); return calls.length === 1 ? oldAttempt.promise : newAttempt.promise; });
  try {
    await h.ready(); h.input('old'); h.submit();
    h.close(); h.reopen(); await h.ready(); h.input('current'); h.submit();
    oldAttempt.resolve(); await flush();
    h.input('during-current'); h.submit(); h.closeButton.props.onClick(); h.escape();
    assert.deepEqual(calls, ['old', 'current']);
    assert.equal(h.closeCalls, 0);
    newAttempt.resolve(); await flush();
    h.escape(); assert.equal(h.closeCalls, 1);
  } finally { h.dispose(); }
});
