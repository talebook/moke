import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseLibraryBaseUrl } from '../src/lib/discovery/base-url.ts';
import { readJsonResponse } from '../src/lib/api-core.ts';
import { isServerCapabilitiesFresh, resolveUserAfterSync } from '../src/lib/server-session.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise(setImmediate);

// Run the actual TSX handlers/effects with deterministic hook and timer hosts.
// This is a component-logic regression harness, not DOM/browser evidence.
function componentHarness(path, modules) {
  const hooks = [];
  let cursor = 0;
  let mounted = true;
  let writesAfterUnmount = 0;
  let queuedEffects = [];
  const element = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = {
    Suspense: 'test-suspense',
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ??= { current: initial };
    },
    useState(initial) {
      const index = cursor++;
      const slot = hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, (next) => {
        if (!mounted) writesAfterUnmount++;
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        hooks[index] = { dependencies: [...dependencies], cleanup: previous?.cleanup };
        queuedEffects.push(() => {
          previous?.cleanup?.();
          hooks[index].cleanup = callback();
        });
      }
    },
  };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  }).outputText;
  const compiledModule = { exports: {} };
  const localRequire = (id) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'test-fragment' };
    assert.ok(id in modules, `unexpected component dependency: ${id}`);
    return modules[id];
  };
  new Function('require', 'module', 'exports', code)(localRequire, compiledModule, compiledModule.exports);
  return {
    exports: compiledModule.exports,
    render(component, props) {
      cursor = 0;
      const tree = component(props);
      const effects = queuedEffects; queuedEffects = [];
      effects.forEach((run) => run());
      return tree;
    },
    unmount() { mounted = false; hooks.forEach((slot) => slot?.cleanup?.()); },
    get writesAfterUnmount() { return writesAfterUnmount; },
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  const children = Array.isArray(tree.props?.children) ? tree.props.children : [tree.props?.children];
  for (const child of children) {
    const match = Array.isArray(child) ? child.map((item) => find(item, predicate)).find(Boolean) : find(child, predicate);
    if (match) return match;
  }
}
function fakeClock() {
  let sequence = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) { const id = ++sequence; pending.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => pending.delete(id),
    expire() {
      const current = [...pending.values()]; pending.clear();
      current.forEach(({ callback }) => callback());
    },
  };
}
function accessFixture(request) {
  let session;
  let invalidations = 0;
  session = { serverUrl: 'https://access.invalid/a', sessionRevision: 1,
    invalidateSession() { invalidations++; session = { ...session, sessionRevision: session.sessionRevision + 1 }; } };
  const store = () => session;
  store.getState = () => session;
  const navigation = [];
  const harness = componentHarness('../src/app/access/page.tsx', {
    'next/navigation': { useRouter: () => ({ push: (path) => navigation.push(path) }) },
    'lucide-react': { KeyRound: 'test-icon' },
    '@/lib/api': { request, readJsonResponse },
    '@/lib/discovery/base-url': { parseLibraryBaseUrl },
    '@/lib/store/server': { useServerStore: store },
    '@/components/auth/CaptchaModal': { CaptchaModal: 'test-captcha' },
    '@/lib/native-back': { requestAnimatedBack() {} },
  });
  const inner = harness.exports.default().props.children.type;
  const render = () => harness.render(inner);
  let tree = render();
  find(tree, (node) => node.type === 'input').props.onChange({ target: { value: 'entered-fixture-code' } });
  tree = render();
  return {
    harness, navigation, render,
    submit() { find(render(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    captcha(data) { find(render(), (node) => node.type === 'test-captcha').props.onSuccess(data); },
    updateSession(values) { session = { ...session, ...values }; render(); },
    get invalidations() { return invalidations; },
  };
}

test('access timeout is visible and retryable even if the transport ignores abort', async () => {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const clock = fakeClock();
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  try {
    const first = deferred();
    const retry = deferred();
    const requests = [];
    const fixture = accessFixture((_url, init) => { requests.push(init); return requests.length === 1 ? first.promise : retry.promise; });
    fixture.submit();
    assert.equal(find(fixture.render(), (node) => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
    clock.expire();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(find(fixture.render(), (node) => node.props.role === 'alert').props.children, '验证超时，请重试。');
    assert.equal(find(fixture.render(), (node) => node.type === 'button' && node.props.type === 'submit').props.disabled, false);
    fixture.submit();
    first.resolve(json({ err: 'ok' }));
    await flush();
    assert.deepEqual(fixture.navigation, []);
    assert.equal(fixture.invalidations, 0);
    assert.equal(find(fixture.render(), (node) => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
    retry.resolve(json({ err: 'ok' }));
    await flush();
    assert.deepEqual(fixture.navigation, ['/shelf']);
    assert.equal(fixture.invalidations, 1);
    fixture.harness.unmount();
  } finally { globalThis.setTimeout = previousSetTimeout; globalThis.clearTimeout = previousClearTimeout; }
});

test('source changes and unmount suppress old timeout messages and late success', async () => {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const clock = fakeClock();
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  try {
    const late = deferred();
    const fixture = accessFixture(() => late.promise);
    fixture.submit();
    fixture.updateSession({ serverUrl: 'https://other.invalid/b', sessionRevision: 2 });
    clock.expire();
    assert.equal(find(fixture.render(), (node) => node.props.role === 'alert'), undefined);
    fixture.harness.unmount();
    late.resolve(json({ err: 'ok' }));
    await flush();
    assert.deepEqual(fixture.navigation, []);
    assert.equal(fixture.harness.writesAfterUnmount, 0);
  } finally { globalThis.setTimeout = previousSetTimeout; globalThis.clearTimeout = previousClearTimeout; }
});

test('active-session access protects the code field and does not navigate on HTTP failure', async () => {
  let sent;
  const fixture = accessFixture(async (_url, init) => { sent = init; return json({ err: 'ok' }, 503); });
  fixture.captcha({ invite_code: 'must-not-win', captcha_code: 'fixture-captcha' });
  await flush();
  assert.equal(sent.body.get('invite_code'), 'entered-fixture-code');
  assert.equal(sent.body.get('captcha_code'), 'fixture-captcha');
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.maxRedirections, 0);
  assert.equal(find(fixture.render(), (node) => node.props.role === 'alert').props.children, '访问码验证失败');
  assert.deepEqual(fixture.navigation, []);
  fixture.harness.unmount();
});

test('Provider preserves confirmed auth and capabilities on an unconfirmed welcome error, with a safe diagnostic', async () => {
  const calls = [];
  const diagnostics = [];
  const oldUser = { id: 'fixture-user' };
  const oldCapabilities = { checkedAt: null, annotationApiStatus: 'unchecked', annotationApiCheckedAt: null };
  const state = { serverUrl: 'https://provider.invalid/a', sessionRevision: 9, hasHydrated: true, offlineMode: false,
    user: oldUser, capabilities: oldCapabilities,
    setServerTitle: () => calls.push('set-title'), setUser: () => calls.push('set-user'),
    setServerCapabilities: () => calls.push('set-capabilities') };
  const store = (selector) => selector(state);
  store.getState = () => state;
  const harness = componentHarness('../src/components/providers/ServerProvider.tsx', {
    'zustand': { useStore: (nativeState, selector) => selector(nativeState.getState()) },
    '@/lib/native-connection': {
      nativeConnection: { state: { getState: () => ({ phase: 'unbound' }) }, isActive: () => false },
      isNativeConnectionRuntime: () => false,
    },
    'next/navigation': { useRouter: () => ({ replace: () => calls.push('navigate') }), usePathname: () => '/shelf' },
    '@/lib/api': {
      checkWelcomeRequirement: async () => ({ err: 'network.error', needsAccessCode: false }),
      fetchCurrentUser: async () => calls.push('fetch-user'), fetchServerInfo: async () => calls.push('fetch-title'),
      discoverServerCapabilities: async () => calls.push('fetch-capabilities'),
    },
    '@/lib/store/server': { useServerStore: store },
    '@/lib/server-capabilities': { getServerDiscoveryInputs: () => [state.serverUrl, null] },
    '@/lib/moke-reader': { navigateFullDocument: () => calls.push('navigate-full') },
    '@/lib/server-session': { isServerCapabilitiesFresh, resolveUserAfterSync },
    '@/lib/api-log': { logErrorMetadata: (tag, payload) => diagnostics.push({ tag, err: payload.err }) },
  });
  harness.render(harness.exports.ServerProvider, { children: 'fixture' });
  await flush();
  assert.deepEqual(calls, []);
  assert.deepEqual(diagnostics, [{ tag: 'ServerProvider welcome check failed', err: 'network.error' }]);
  assert.equal(state.user, oldUser);
  assert.equal(state.capabilities, oldCapabilities);
  harness.unmount();
});
