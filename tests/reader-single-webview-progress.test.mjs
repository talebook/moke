import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { buildEmbeddedReaderUrl } from '../src/lib/moke-reader.ts';
import {
  bootstrapMokeLaunchContext,
  mokeProgressStorageKey,
} from '../readest/apps/readest-app/src/helpers/mokeLaunchContext.ts';

// Single-WebView navigation unloads Moke's Provider. Run the pinned Reader's
// actual bootstrap and persistence code, mocking only DOM and native transport.
// These checks do not claim native WebView or authenticated-device acceptance.
const helperUrl = new URL('../readest/apps/readest-app/src/helpers/mokeLaunchContext.ts', import.meta.url).href;
const bridgeSource = readFileSync(new URL('../readest/apps/readest-app/src/services/mokeBridge.ts', import.meta.url), 'utf8');
const bridgeCode = ts.transpileModule(bridgeSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const hostKey = '__readerSingleWebviewProgressHost';
const mocks = new Map([
  ['@tauri-apps/api/core', `export async function invoke(command, args) {
    globalThis.${hostKey}.invokes.push({ command, args });
  }`],
  ['@tauri-apps/plugin-http', `export async function fetch(url, init) {
    globalThis.${hostKey}.writes.push({ url, init });
    return Response.json({ err: 'ok' });
  }`],
]);
let documentId = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

async function launchReader(context, platform, serverUrl) {
  const previousGlobals = new Map(['window', 'document', hostKey]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const host = { invokes: [], writes: [] };
  const readerWindow = new EventTarget();
  const readerDocument = new EventTarget();
  const href = buildEmbeddedReaderUrl({
    filePath: '/books/42.epub',
    eink: false,
    mokeBookId: '42',
    restoreProgress: null,
    serverUrl,
    runtimePlatform: platform,
  });
  readerWindow.location = new URL(href, 'https://moke.invalid');
  readerWindow.localStorage = createStorage();
  readerDocument.visibilityState = 'visible';
  globalThis.window = readerWindow;
  globalThis.document = readerDocument;
  globalThis[hostKey] = host;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const hooks = registerHooks({ resolve(specifier, moduleContext, next) {
    if (mocks.has(specifier)) return { url: moduleUrl(mocks.get(specifier)), shortCircuit: true };
    if (specifier === '@/helpers/mokeLaunchContext') return next(helperUrl, moduleContext);
    return next(specifier, moduleContext);
  } });
  context.after(async () => {
    context.mock.timers.reset();
    await settle();
    hooks.deregister();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  bootstrapMokeLaunchContext();
  // A new document has fresh bridge module state and event subscriptions.
  const bridge = await import(`${moduleUrl(bridgeCode)}#document-${++documentId}`);
  assert.equal(readerWindow.__MOKE_EMBEDDED, true);
  assert.equal(readerWindow.__MOKE_BOOK_ID, '42');
  assert.equal(readerWindow.__MOKE_SERVER_URL, serverUrl || null);
  assert.equal(readerWindow.__MOKE_RUNTIME_PLATFORM, platform);
  return { host, readerWindow, readerDocument, ...bridge };
}

const page = location => ({
  book_id: 'reader-hash', view_key: 'reader-view', location, page: 7, fraction: 0.07,
});

function assertSavedSource(host, serverUrl, location) {
  assert.equal(host.writes.length, 1, 'Reader saves without mounting the Moke Provider');
  const { url, init } = host.writes[0];
  assert.equal(url, `${serverUrl}/api/book/42/progress`);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const { progress } = JSON.parse(init.body);
  assert.equal(progress.schema, 'moke.readest.progress.v1');
  assert.equal(progress.reader, 'readest');
  assert.equal(progress.moke_book_id, '42');
  assert.equal(progress.reader_book_id, 'reader-hash');
  assert.equal(progress.location, location);
  assert.equal(progress.page, 7);
  assert.equal(progress.fraction, 0.07);
}

for (const platform of ['ohos', 'android', 'ios']) {
  for (const trigger of ['debounce', 'book:closed', 'pagehide', 'visibilitychange']) {
    test(`${platform} launch context saves coalesced Reader progress to its source on ${trigger}`, async context => {
      const serverUrl = trigger === 'book:closed' ? 'https://a.test' : 'https://b.test';
      const reader = await launchReader(context, platform, serverUrl);
      await reader.emitReaderEvent('page:changed', page('first'));
      context.mock.timers.tick(400);
      await reader.emitReaderEvent('page:changed', page('latest'));
      assert.equal(reader.host.writes.length, 0);
      const local = JSON.parse(reader.readerWindow.localStorage.getItem(mokeProgressStorageKey(serverUrl, '42')));
      assert.equal(local.location, 'latest');

      if (trigger === 'debounce') {
        context.mock.timers.tick(1199);
        await settle();
        assert.equal(reader.host.writes.length, 0, 'later page turns restart the debounce');
        context.mock.timers.tick(1);
      } else if (trigger === 'book:closed') {
        await reader.emitReaderEvent('book:closed', { book_id: 'reader-hash' });
        assert.equal(reader.host.invokes.at(-1).args.event, 'book:closed');
      } else if (trigger === 'pagehide') {
        reader.readerWindow.dispatchEvent(new Event('pagehide'));
      } else {
        // Becoming visible must not prematurely save pending progress.
        reader.readerDocument.dispatchEvent(new Event('visibilitychange'));
        await settle();
        assert.equal(reader.host.writes.length, 0);
        reader.readerDocument.visibilityState = 'hidden';
        reader.readerDocument.dispatchEvent(new Event('visibilitychange'));
      }
      await settle();
      assertSavedSource(reader.host, serverUrl, 'latest');
      context.mock.timers.tick(2000);
      await settle();
      assert.equal(reader.host.writes.length, 1, 'flushing clears the pending debounce and avoids duplicate saves');
    });
  }
}

test('desktop Reader without mokeServerUrl leaves server persistence to Moke and still emits events', async context => {
  const reader = await launchReader(context, 'windows');
  await reader.emitReaderEvent('page:changed', page('desktop-position'));
  context.mock.timers.tick(1300);
  await settle();
  await reader.emitReaderEvent('book:closed', { book_id: 'reader-hash' });
  assert.deepEqual(reader.host.writes, []);
  assert.equal(reader.host.invokes.at(-1).command, 'ext_reader_event');
  assert.equal(reader.host.invokes.at(-1).args.event, 'book:closed');
  assert.equal(reader.host.invokes.at(-1).args.data.moke_book_id, '42');
  const local = JSON.parse(reader.readerWindow.localStorage.getItem(mokeProgressStorageKey('', '42')));
  assert.equal(local.location, 'desktop-position');
});
