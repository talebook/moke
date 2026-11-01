import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { clearReadStateCache, filterReadingStateBooks } from '../src/lib/reading-state.ts';

process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
const { saveReadingProgress } = await import('../src/lib/reading-progress.ts');
const { useServerStore, DEFAULT_SERVER_CAPABILITIES } = await import('../src/lib/store/server.ts');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function readStateResponse(state) {
  return new Response(JSON.stringify({ err: 'ok', read_state: state }), {
    headers: { 'content-type': 'application/json' },
  });
}

function unsupportedResponse() {
  return new Response(JSON.stringify({ err: 'page.not_found' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });
}

function session(serverUrl, sessionRevision) {
  useServerStore.setState({ serverUrl, sessionRevision, savedServerId: null,
    capabilities: { ...DEFAULT_SERVER_CAPABILITIES, readingProgressApi: true, checkedAt: 100 },
  });
}

const progress = {
  schema: 'moke.readest.progress.v1', reader: 'readest', moke_book_id: '42',
  location: 'epubcfi(/6/4)', updated_at: '2026-11-01T08:00:00.000Z',
};

test('clearing read-state generation prevents a late response from refilling the cleared cache', async () => {
  clearReadStateCache();
  const pending = deferred();
  let calls = 0;
  const first = filterReadingStateBooks(async () => { calls++; return pending.promise; }, 'https://books.example/a', [{ id: '42' }]);
  assert.equal(calls, 1);
  clearReadStateCache();
  pending.resolve(readStateResponse(2));
  assert.deepEqual((await first).finished.map(({ id }) => id), ['42']);
  const current = await filterReadingStateBooks(async () => { calls++; return readStateResponse(1); }, 'https://books.example/a', [{ id: '42' }]);
  assert.equal(calls, 2, 'the old response must not supply the new generation');
  assert.deepEqual(current.reading.map(({ id }) => id), ['42']);
  const cached = await filterReadingStateBooks(async () => { throw new Error('unexpected fresh request'); }, 'https://books.example/a', [{ id: '42' }]);
  assert.deepEqual(cached.reading.map(({ id }) => id), ['42']);
});

test('late A cannot replace B state or become a reusable A cache after the source switch', async () => {
  clearReadStateCache();
  const aUrl = 'https://books.example/a';
  const bUrl = 'https://books.example/b';
  const pending = deferred();
  const calls = [];
  const oldA = filterReadingStateBooks(async (url) => { calls.push(url); return pending.promise; }, aUrl, [{ id: 42 }]);
  clearReadStateCache();
  const b = await filterReadingStateBooks(async (url) => { calls.push(url); return readStateResponse(1); }, bUrl, [{ id: 42 }]);
  assert.deepEqual(b.reading.map(({ id }) => id), [42]);
  pending.resolve(readStateResponse(2));
  await oldA;
  const bAgain = await filterReadingStateBooks(async () => { throw new Error('B must remain cached'); }, bUrl, [{ id: 42 }]);
  assert.deepEqual(bAgain.reading.map(({ id }) => id), [42]);
  const freshA = await filterReadingStateBooks(async (url) => { calls.push(url); return readStateResponse(1); }, aUrl, [{ id: 42 }]);
  assert.deepEqual(freshA.reading.map(({ id }) => id), [42]);
  assert.deepEqual(calls, [`${aUrl}/api/book/42/readstate`, `${bUrl}/api/book/42/readstate`, `${aUrl}/api/book/42/readstate`]);
});

test('an A progress POST completing after B activation keeps its source URL and cannot downgrade B', async (t) => {
  const a = 'https://books.example/a';
  const b = 'https://books.example/b';
  session(a, 4);
  const pending = deferred();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), method: init.method, credentials: init.credentials, body: JSON.parse(init.body) });
    return pending.promise;
  });
  const saving = saveReadingProgress('42', progress, { serverUrl: a, sessionRevision: 4 });
  session(b, 5);
  const capabilities = useServerStore.getState().capabilities;
  pending.resolve(unsupportedResponse());
  await saving;
  assert.deepEqual(calls, [{ url: `${a}/api/book/42/progress`, method: 'POST', credentials: 'include', body: { progress } }]);
  assert.equal(useServerStore.getState().serverUrl, b);
  assert.strictEqual(useServerStore.getState().capabilities, capabilities);
  assert.equal(useServerStore.getState().capabilities.readingProgressApi, true);
});

test('an explicit different source cannot downgrade B even when revision numbers coincide', async (t) => {
  const a = 'https://books.example/a';
  const b = 'https://books.example/b';
  session(b, 10);
  const capabilities = useServerStore.getState().capabilities;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return unsupportedResponse(); });
  await saveReadingProgress('42', progress, { serverUrl: a, sessionRevision: 10 });
  assert.deepEqual(calls, [`${a}/api/book/42/progress`]);
  assert.strictEqual(useServerStore.getState().capabilities, capabilities);
  assert.equal(useServerStore.getState().capabilities.readingProgressApi, true);
});

test('a matching current-source unsupported progress response still downgrades that source', async (t) => {
  const a = 'https://books.example/a';
  session(a, 12);
  t.mock.method(globalThis, 'fetch', async () => unsupportedResponse());
  await saveReadingProgress('42', progress, { serverUrl: a, sessionRevision: 12 });
  assert.equal(useServerStore.getState().serverUrl, a);
  assert.equal(useServerStore.getState().capabilities.readingProgressApi, false);
});
