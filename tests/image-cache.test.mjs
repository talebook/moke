import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { useServerStore } from '../src/lib/store/server.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const observe = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const response = () => new Response(new Blob(['cover'], { type: 'image/png' }));
let moduleId = 0;

test('covers load and discard late responses without AbortSignal.throwIfAborted', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted');
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', descriptor));
  const late = Promise.withResolvers();
  const lateResponse = response();
  const cancelled = t.mock.method(lateResponse.body, 'cancel');
  const created = t.mock.method(URL, 'createObjectURL');
  const cache = await installCache(t, async (url) => url.endsWith('/late') ? late.promise : response());
  assert.match(await cache.acquire('https://books.test/portable'), /^blob:/);
  const pending = observe(cache.acquire('https://books.test/late'));
  cache.releaseImageObjectUrl('https://books.test/late', 0);
  await tick();
  assert.equal((await pending).error.name, 'AbortError');
  late.resolve(lateResponse);
  await tick();
  assert.equal(cancelled.mock.callCount(), 1);
  assert.equal(created.mock.callCount(), 1);
});

test('session changes revoke unused covers and retain shared covers until the last release', async (t) => {
  useServerStore.getState().invalidateSession();
  const cache = await installCache(t, async () => response());
  const revision = useServerStore.getState().sessionRevision;
  const unused = 'https://books.test/unused';
  const shared = 'https://books.test/shared';
  const revoked = t.mock.method(URL, 'revokeObjectURL');
  const unusedBlob = await cache.acquire(unused, revision);
  cache.releaseImageObjectUrl(unused, revision);
  const sharedBlob = await cache.acquire(shared, revision);
  await cache.acquire(shared, revision);
  useServerStore.getState().invalidateSession();
  assert.equal(cache.getCachedImageObjectUrl(unused, revision), null);
  assert.deepEqual(revoked.mock.calls.map(call => call.arguments[0]), [unusedBlob]);
  cache.releaseImageObjectUrl(shared, revision);
  assert.equal(cache.getCachedImageObjectUrl(shared, revision), sharedBlob);
  cache.releaseImageObjectUrl(shared, revision);
  assert.equal(cache.getCachedImageObjectUrl(shared, revision), null);
  assert.deepEqual(revoked.mock.calls.map(call => call.arguments[0]), [unusedBlob, sharedBlob]);
});

async function installCache(t, fetch) {
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
  t.mock.method(globalThis, 'fetch', fetch);
  const cache = await import(`../src/lib/api.ts?image-test=${moduleId++}`);
  const references = [];
  t.after(async () => {
    for (const [url, session] of references) cache.releaseImageObjectUrl(url, session);
    await tick();
  });
  return {
    ...cache,
    acquire(url, session = 0) {
      references.push([url, session]);
      return cache.acquireImageObjectUrl(url, session);
    },
  };
}

test('six hanging old covers do not block a new page/session after release', async (t) => {
  const calls = [];
  const cache = await installCache(t, async (url, init) => {
    calls.push({ url, signal: init.signal });
    return url.includes('/old/') ? new Promise(() => {}) : response();
  });
  const old = Array.from({ length: 6 }, (_, i) => `https://old.books.test/old/${i}`);
  const pending = old.map((url) => observe(cache.acquire(url)));
  await tick();
  assert.equal(calls.length, 6);
  for (const url of old) cache.releaseImageObjectUrl(url, 0);
  const fresh = Array.from({ length: 6 }, (_, i) => cache.acquire(`https://new.books.test/new/${i}`, 1));
  await Promise.all(fresh);
  assert.equal(calls.length, 12);
  assert.ok(calls.slice(0, 6).every(({ signal }) => signal.aborted));
  assert.ok((await Promise.all(pending)).every(({ error }) => error.name === 'AbortError'));
});

test('zero-reference queued covers are removed without issuing requests', async (t) => {
  const calls = [];
  const cache = await installCache(t, async (url) => {
    calls.push(url);
    return new Promise(() => {});
  });
  const old = Array.from({ length: 6 }, (_, i) => `https://books.test/${i}`);
  old.forEach((url) => observe(cache.acquire(url)));
  const queued = observe(cache.acquire('https://books.test/queued'));
  cache.releaseImageObjectUrl('https://books.test/queued', 0);
  await tick();
  assert.equal((await queued).error.name, 'AbortError');
  old.forEach((url) => cache.releaseImageObjectUrl(url, 0));
  await tick();
  assert.equal(calls.includes('https://books.test/queued'), false);
});

test('shared references and StrictMode immediate remount retain one task', async (t) => {
  const gate = Promise.withResolvers();
  let signal;
  let requests = 0;
  const cache = await installCache(t, async (_url, init) => {
    requests++;
    signal = init.signal;
    return gate.promise;
  });
  const url = 'https://books.test/shared';
  const first = cache.acquire(url);
  const second = cache.acquire(url);
  assert.equal(first, second);
  cache.releaseImageObjectUrl(url, 0);
  await tick();
  assert.equal(signal.aborted, false);
  cache.releaseImageObjectUrl(url, 0);
  const remounted = cache.acquire(url);
  assert.equal(first, remounted);
  await tick();
  assert.equal(signal.aborted, false);
  gate.resolve(response());
  const objectUrl = await remounted;
  assert.equal(requests, 1);
  assert.equal(await cache.acquire(url), objectUrl);
  assert.equal(requests, 1);
});

test('cancelled and failed loads retry; late responses cannot replace or delete a new task', async (t) => {
  const old = Promise.withResolvers();
  const replacement = Promise.withResolvers();
  let requests = 0;
  const created = t.mock.method(URL, 'createObjectURL');
  const cache = await installCache(t, async () => {
    requests++;
    if (requests === 1) return old.promise;
    if (requests === 2) return replacement.promise;
    if (requests === 3) return new Response('', { status: 500 });
    return response();
  });
  const url = 'https://books.test/retry';
  const abandoned = observe(cache.acquire(url));
  cache.releaseImageObjectUrl(url, 0);
  await tick();
  assert.equal((await abandoned).error.name, 'AbortError');
  const fresh = cache.acquire(url);
  old.resolve(response());
  await tick();
  assert.equal(cache.getCachedImageObjectUrl(url, 0), null);
  assert.equal(created.mock.callCount(), 0);
  assert.equal(cache.acquire(url), fresh);
  assert.equal(requests, 2);
  replacement.resolve(response());
  await fresh;
  const failed = observe(cache.acquire('https://books.test/failed'));
  assert.match((await failed).error.message, /image.http.500/);
  await cache.acquire('https://books.test/failed');
  assert.equal(requests, 4);
});

for (const stage of ['request', 'body', 'queue']) {
  test(`total timeout bounds ${stage} and permits retry`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let fail = true;
    let signal;
    const cache = await installCache(t, async (_url, init) => {
      signal = init.signal;
      if (!fail) return response();
      if (stage === 'body') return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      return new Promise(() => {});
    });
    if (stage === 'queue') {
      for (let i = 0; i < 6; i++) observe(cache.acquire(`https://books.test/blocker/${i}`));
    }
    const url = 'https://books.test/timeout';
    const pending = observe(cache.acquire(url));
    await tick();
    t.mock.timers.tick(15_000);
    assert.equal((await pending).error.name, 'TimeoutError');
    assert.equal(signal.aborted, true);
    fail = false;
    await cache.acquire(url);
  });
}

test('LRU evicts unused URLs while retaining referenced covers', async (t) => {
  const cache = await installCache(t, async () => response());
  const url = 'https://books.test/pinned';
  const pinned = await cache.acquire(url);
  for (let i = 0; i < 130; i++) {
    const unused = `https://books.test/unused/${i}`;
    await cache.acquire(unused);
    cache.releaseImageObjectUrl(unused, 0);
  }
  assert.equal(cache.getCachedImageObjectUrl(url, 0), pinned);
  assert.equal(cache.getCachedImageObjectUrl('https://books.test/unused/0', 0), null);
});

test('the same URL is isolated by session revision', async (t) => {
  let requests = 0;
  const cache = await installCache(t, async () => { requests++; return response(); });
  const url = 'https://books.test/session';
  const old = await cache.acquire(url, 0);
  const fresh = await cache.acquire(url, 1);
  assert.notEqual(old, fresh);
  assert.equal(requests, 2);
  assert.equal(cache.getCachedImageObjectUrl(url, 0), old);
  assert.equal(cache.getCachedImageObjectUrl(url, 1), fresh);
});

test('a cancelled body that resolves late never creates an object URL', async (t) => {
  const gate = Promise.withResolvers();
  const created = t.mock.method(URL, 'createObjectURL');
  const cache = await installCache(t, async () => {
    const res = response();
    res.blob = () => gate.promise;
    return res;
  });
  const url = 'https://books.test/late-body';
  const pending = observe(cache.acquire(url));
  await tick();
  cache.releaseImageObjectUrl(url, 0);
  await tick();
  assert.equal((await pending).error.name, 'AbortError');
  gate.resolve(new Blob(['late cover']));
  await tick();
  assert.equal(created.mock.callCount(), 0);
  assert.equal(cache.getCachedImageObjectUrl(url, 0), null);
});
