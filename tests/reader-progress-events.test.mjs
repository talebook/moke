import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { createReaderSourceBoundary } from '../src/lib/reader-source.ts';
import { READER_PROGRESS_TIMEOUT_MS } from '../src/lib/reader-progress-queue.ts';

// Exercise the pinned Reader bridge and the production host subscription with
// synthetic IPC/React effects. Persistence and annotation filtering have their
// own tests; this fixture checks event naming, ownership and close delivery.
const host = globalThis.__readerProgressEventsHost = {
  effect: null, listener: null, boundary: null, invokes: [], writes: [], warnings: [], save: null,
  unregisters: 0, unlistens: 0,
  context: { sessionId: 1, offlineMode: false }, remembered: [],
};
const moduleUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source);
const mocks = new Map([
  ['react', 'export function useEffect(effect) { globalThis.__readerProgressEventsHost.effect = effect; }'],
  ['react/jsx-runtime', 'export const Fragment = Symbol(); export function jsx() { return null; }'],
  ['@tauri-apps/api/core', `export async function invoke(command, args) {
    const host = globalThis.__readerProgressEventsHost;
    host.invokes.push({ command, args });
    host.listener({ payload: { window: host.windowLabel, ...args } });
  }`],
  ['@tauri-apps/api/event', `export async function listen(event, listener) {
    const host = globalThis.__readerProgressEventsHost;
    host.event = event; host.listener = listener;
    return () => { host.unlistens++; host.listener = null; };
  }`],
  ['@/lib/reader-source', `const host = globalThis.__readerProgressEventsHost;
    export const sourceForReaderEvent = (...args) => host.boundary.sourceForReaderEvent(...args);
    export const retireReaderWindow = (...args) => host.boundary.retireReaderWindow(...args);
    export const registerReaderProgressFlush = (...args) => {
      const unregister = host.boundary.registerReaderProgressFlush(...args);
      return () => { host.unregisters++; unregister(); };
    };`],
  ['@/lib/reading-progress', `export const normalizeReaderProgressEvent = data => data;
    export function saveReadingProgress(bookId, progress, serverUrl, signal) {
      const host = globalThis.__readerProgressEventsHost;
      host.writes.push({ bookId, progress, serverUrl });
      return host.save ? host.save(signal) : Promise.resolve();
    }`],
  ['@/lib/annotations', `export const clearAnnotationLocateProgressSuppressionFromPayload = () => {};
    export const shouldSuppressAnnotationReaderProgress = () => false;`],
  ['@/lib/debug-log', `export const debugLog = (...args) => globalThis.__readerProgressEventsHost.warnings.push(args);`],
  ['@/lib/store/server', `export const useServerStore = {getState: () => globalThis.__readerProgressEventsHost.context};`],
  ['@/lib/continue-reading', `export const rememberContinueReading = update => globalThis.__readerProgressEventsHost.remembered.push(update);`],
]);
const realModules = new Map([
  ['@/lib/async-subscription', new URL('../src/lib/async-subscription.ts', import.meta.url).href],
  ['@/lib/reader-progress-queue', new URL('../src/lib/reader-progress-queue.ts', import.meta.url).href],
  ['@/helpers/mokeLaunchContext', new URL('../readest/apps/readest-app/src/helpers/mokeLaunchContext.ts', import.meta.url).href],
]);
registerHooks({ resolve(specifier, context, next) {
  if (mocks.has(specifier)) return { url: moduleUrl(mocks.get(specifier)), shortCircuit: true };
  if (realModules.has(specifier)) return next(realModules.get(specifier), context);
  return next(specifier, context);
} });
async function importTranspiled(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return import(moduleUrl(compiled));
}
const { ReaderProgressProvider } = await importTranspiled('../src/components/providers/ReaderProgressProvider.tsx');
// Reader uses parameter properties, which Node's strip-only mode cannot load.
const { emitReaderEvent } = await importTranspiled('../readest/apps/readest-app/src/services/mokeBridge.ts');

test.beforeEach(() => {
  host.context = { sessionId: 1, offlineMode: false };
  host.remembered = [];
});

test('pinned Reader book:closed reaches the host, flushes A and rejects late A events after opening same-id B', async () => {
  const previousWindow = globalThis.window;
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  globalThis.window = { __MOKE_EMBEDDED: true, __MOKE_BOOK_ID: '42', localStorage: { setItem() {} } };
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  const state = { labels: [], sessionId: 1, nextLabel: 'reader-0' };
  host.context = state;
  host.boundary = createReaderSourceBoundary({
    getWindowLabels: async () => [...state.labels],
    getContext: async () => ({ sessionId: state.sessionId, candidate: null }),
    open: async () => { state.labels = [state.nextLabel]; },
    wait: async () => assert.fail('the reader should be immediately observable'), now: () => 0,
  });
  host.invokes = []; host.writes = []; host.warnings = [];
  host.save = null; host.unregisters = 0; host.unlistens = 0;
  let cleanup;
  try {
    ReaderProgressProvider({ children: null });
    cleanup = host.effect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.event, 'moke:reader:event');
    const a = { serverUrl: 'http://a.test', bookId: '42', sessionId: 1 };
    await host.boundary.openReaderFromSource(a, {});
    host.windowLabel = 'reader-0';
    await emitReaderEvent('page:changed', { book_id: 'reader-hash', view_key: 'reader-hash-0', location: 'A-position' });
    await emitReaderEvent('book:closed', { book_id: 'reader-hash', view_key: 'reader-hash-0' });
    assert.deepEqual(host.invokes.at(-1), {
      command: 'ext_reader_event',
      args: { event: 'book:closed', data: { book_id: 'reader-hash', view_key: 'reader-hash-0', moke_book_id: '42' } },
    });
    assert.equal(host.boundary.sourceForReaderEvent('reader-0', '42'), null);
    // A book close is not proof that its WebView has disappeared.
    await assert.rejects(host.boundary.withClosedReaderSession(async () => assert.fail('window still exists')), /请先关闭/);
    state.labels = [];
    await host.boundary.withClosedReaderSession(async () => { state.sessionId = 2; });
    assert.deepEqual(host.writes.map(({ bookId, progress, serverUrl }) => [serverUrl, bookId, progress.location]),
      [['http://a.test', '42', 'A-position']]);
    state.nextLabel = 'reader-1';
    await host.boundary.openReaderFromSource({ serverUrl: 'http://b.test', bookId: '42', sessionId: 2 }, {});
    // A delayed event from the authenticated old label cannot gain B ownership.
    host.listener({ payload: { window: 'reader-0', event: 'page:changed', data: { moke_book_id: '42', location: 'late-A' } } });
    host.windowLabel = 'reader-1';
    await emitReaderEvent('book:closed', { book_id: 'reader-hash', view_key: 'reader-hash-0' });
    state.labels = [];
    await host.boundary.requireClosedReaders();
    assert.equal(host.writes.length, 1);
    assert.equal(host.warnings.length, 1);
  } finally {
    cleanup?.();
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.window = previousWindow;
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  }
});

test('continue-reading keeps the authenticated offline source and ignores stale-session events', async context => {
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  context.after(() => {
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  });
  host.context = { sessionId: 1, offlineMode: true, serverUrl: 'https://b.test' };
  host.boundary = createReaderSourceBoundary({
    getWindowLabels: async () => ['reader-continue'], getContext: async () => host.context,
    open: async () => assert.fail('already bound'), wait: async () => {}, now: () => 0,
  });
  host.boundary.bindReaderWindow('reader-continue', { serverUrl: 'https://a.test', bookId: '42', sessionId: 1 });
  host.save = null; host.writes = [];
  ReaderProgressProvider({ children: null });
  const cleanup = host.effect();
  try {
    await new Promise(resolve => setImmediate(resolve));
    const event = { payload: { window: 'reader-continue', event: 'page:changed',
      data: { moke_book_id: '42', fraction: 0.5, page: 4, total_pages: 8 } } };
    host.listener(event);
    assert.deepEqual(host.remembered, [{ serverUrl: 'https://a.test', mode: 'offline', bookId: '42',
      progress: 0.5, page: 4, totalPages: 8 }]);
    host.context.sessionId = 2;
    host.listener(event);
    assert.equal(host.remembered.length, 1);
    host.listener({ payload: { window: 'reader-unknown', event: 'page:changed', data: event.payload.data } });
    assert.equal(host.remembered.length, 1);
  } finally {
    cleanup();
    await new Promise(resolve => setImmediate(resolve));
  }
});

for (const failure of ['reject', 'throw']) {
  test(`host close/unmount catches ${failure}ing progress saves, unregisters and permits session changes`, async context => {
    const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
    process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
    context.after(() => {
      if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
      else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
      host.save = null;
    });
    const unhandled = [];
    const onUnhandled = error => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    context.after(() => process.off('unhandledRejection', onUnhandled));
    const state = { sessionId: 1 };
    host.boundary = createReaderSourceBoundary({
      getWindowLabels: async () => [],
      getContext: async () => ({ sessionId: state.sessionId, candidate: null }),
      open: async () => assert.fail('no Reader is opened by this effect test'),
      wait: async () => {}, now: () => 0,
    });
    const source = { serverUrl: 'https://a.test', bookId: '42', sessionId: 1 };
    host.boundary.bindReaderWindow('reader-a', source);
    host.writes = []; host.warnings = []; host.unregisters = 0; host.unlistens = 0;
    host.save = () => {
      const error = new Error('token=fixture-secret; internal response');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    };
    ReaderProgressProvider({ children: null });
    const cleanup = host.effect();
    await new Promise(resolve => setImmediate(resolve));
    host.listener({ payload: { window: 'reader-a', event: 'page:changed', data: { moke_book_id: '42', location: 'A-position' } } });
    host.listener({ payload: { window: 'reader-a', event: 'book:closed', data: {} } });
    cleanup();
    await host.boundary.withClosedReaderSession(async () => { state.sessionId = 2; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.sessionId, 2);
    assert.equal(host.listener, null);
    assert.equal(host.unlistens, 1);
    assert.equal(host.unregisters, 1);
    assert.equal(host.writes.length, 1);
    assert.equal(host.warnings.length, 1);
    assert.deepEqual(host.warnings[0], ['warn', 'reader-progress', '阅读进度同步失败，已继续处理连接与阅读器操作', { reason: 'rejected', ...source }]);
    assert.doesNotMatch(JSON.stringify(host.warnings), /fixture-secret|internal response/);
    assert.deepEqual(unhandled, []);
  });
}

test('a hanging host save is aborted at its deadline and unmount unregisters before late rejection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  context.after(() => {
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
    host.save = null;
  });
  const unhandled = [];
  const onUnhandled = error => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  context.after(() => process.off('unhandledRejection', onUnhandled));
  const state = { sessionId: 1 };
  host.boundary = createReaderSourceBoundary({
    getWindowLabels: async () => [],
    getContext: async () => ({ sessionId: state.sessionId, candidate: null }),
    open: async () => assert.fail('the effect does not open a Reader'),
    wait: async () => {}, now: () => 0,
  });
  const source = { serverUrl: 'https://a.test', bookId: '42', sessionId: 1 };
  host.boundary.bindReaderWindow('reader-timeout', source);
  host.writes = []; host.warnings = []; host.unregisters = 0; host.unlistens = 0;
  let started, rejectSave, signal;
  const entered = new Promise(resolve => { started = resolve; });
  const stalled = new Promise((_, reject) => { rejectSave = reject; });
  // This mock deliberately ignores cancellation to verify late rejection safety.
  host.save = abortSignal => { signal = abortSignal; started(); return stalled; };
  ReaderProgressProvider({ children: null });
  const cleanup = host.effect();
  let cleaned = false;
  const clean = () => { if (!cleaned) { cleaned = true; cleanup(); } };
  context.after(clean);
  await new Promise(resolve => setImmediate(resolve));
  host.listener({ payload: { window: 'reader-timeout', event: 'page:changed', data: { moke_book_id: '42', location: 'A-position' } } });
  host.listener({ payload: { window: 'reader-timeout', event: 'book:closed', data: {} } });
  await entered;
  clean();
  const changing = host.boundary.withClosedReaderSession(async () => { state.sessionId = 2; });
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(READER_PROGRESS_TIMEOUT_MS);
  await changing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true, 'the Provider forwards the request cancellation signal');
  assert.equal(host.unlistens, 1);
  assert.equal(host.unregisters, 1);
  assert.equal(host.listener, null);
  assert.equal(state.sessionId, 2);
  assert.deepEqual(host.warnings, [['warn', 'reader-progress', '阅读进度同步失败，已继续处理连接与阅读器操作', { reason: 'timeout', ...source }]]);
  rejectSave(new Error('token=fixture-secret; late internal response'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(host.warnings), /fixture-secret|internal response/);
  assert.deepEqual(unhandled, []);
});

test('the pinned primary Reader close handler awaits the advertised book:closed contract', () => {
  const contract = JSON.parse(readFileSync(new URL('../readest/contract/moke-reader.v1.json', import.meta.url), 'utf8'));
  assert.ok(contract.readerEvents.includes('book:closed'));
  assert.ok(contract.hostCommands.includes('ext_reader_event'));
  const source = readFileSync(new URL('../readest/apps/readest-app/src/app/reader/components/ReaderContent.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('ReaderContent.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const closeCalls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'emitReaderEvent' &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'book:closed') closeCalls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(closeCalls.length > 0, 'Reader primary close handler must emit the advertised event');
  for (const call of closeCalls) assert.ok(ts.isAwaitExpression(call.parent), 'close delivery must finish before destroying the reader');
});
