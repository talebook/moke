import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';

process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
const { downloadBookBlob, streamBookDownload } = await import('../src/lib/api.ts');
const { downloadAndSaveOfflineBook } = await import('../src/lib/offline-download.ts');
const { useServerStore } = await import('../src/lib/store/server.ts');

const A = 'https://a.example/team/books';
const B = 'https://b.example/library';
const encoder = new TextEncoder();

function session(serverUrl, sessionRevision) {
  useServerStore.setState({ serverUrl, sessionRevision, savedServerId: null });
}

function textResponse(text) {
  const bytes = encoder.encode(text);
  return new Response(bytes, { headers: {
    'content-type': 'text/plain', 'content-length': String(bytes.length), etag: 'fixture-etag',
  } });
}

function rejectOfflineStorage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map();
  let accesses = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    get indexedDB() { accesses++; throw new Error('Unexpected offline storage access'); },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  return () => accesses;
}

test('the Blob API uses explicit A while the live store points at B', async (t) => {
  session(B, 3);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return textResponse(String(url).startsWith(A) ? 'A bytes only' : 'B bytes must not be used');
  });
  const blob = await downloadBookBlob('42', 'txt', { serverUrl: A });
  assert.deepEqual(calls, [`${A}/api/book/42.txt`]);
  assert.equal(await blob.text(), 'A bytes only');
  assert.equal(useServerStore.getState().serverUrl, B);
});

test('an old A download task rejects before HTTP or offline storage when B is current', async (t) => {
  const storageAccesses = rejectOfflineStorage(t);
  session(B, 5);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return textResponse('unexpected bytes'); });
  await assert.rejects(downloadAndSaveOfflineBook({ serverUrl: A, bookId: '42', title: 'Fixture', format: 'txt' }));
  assert.deepEqual(calls, []);
  assert.equal(storageAccesses(), 0);
});

for (const switchKind of ['another-server', 'new-session']) {
  test(`a ${switchKind} change while the A cover awaits prevents binary HTTP and storage`, async (t) => {
    const storageAccesses = rejectOfflineStorage(t);
    session(A, 8);
    let releaseCover;
    let markStarted;
    const cover = new Promise((resolve) => { releaseCover = resolve; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    const coverUrl = `${A}/covers/42.jpg`;
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      if (String(url) === coverUrl) { markStarted(); return cover; }
      return textResponse('unexpected binary download');
    });
    const downloading = downloadAndSaveOfflineBook({ serverUrl: A, bookId: '42', title: 'Fixture', format: 'txt', coverUrl });
    await started;
    session(switchKind === 'another-server' ? B : A, 9);
    // A failed optional cover avoids FileReader while still exercising the
    // real awaited cover request and its post-await source/session check.
    releaseCover(new Response(null, { status: 404 }));
    await assert.rejects(downloading);
    assert.deepEqual(calls, [coverUrl]);
    assert.equal(storageAccesses(), 0);
  });
}

test('the stream API uses explicit A and passes its bytes to the injected writer while B remains current', async (t) => {
  session(B, 11);
  const calls = [];
  const chunks = [];
  const text = 'A bytes: 书库';
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return textResponse(String(url).startsWith(A) ? text : 'B bytes must not be used');
  });
  const result = await streamBookDownload('42', 'txt', {
    serverUrl: A,
    async write(chunk) { chunks.push(new Uint8Array(chunk)); },
  });
  assert.deepEqual(calls, [`${A}/api/book/42.txt`]);
  assert.equal(await new Blob(chunks).text(), text);
  assert.equal(result.size, encoder.encode(text).length);
  assert.equal(result.resumed, false);
  assert.equal(result.sourceSignature, 'fixture-etag');
  assert.equal(useServerStore.getState().serverUrl, B);
});

test('both binary APIs capture their implicit live source synchronously before a later store change', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return textResponse('A captured bytes'); });
  session(A, 20);
  const blob = downloadBookBlob('41', 'txt');
  session(B, 21);
  assert.equal(await (await blob).text(), 'A captured bytes');
  session(A, 22);
  const chunks = [];
  const stream = streamBookDownload('42', 'txt', { async write(chunk) { chunks.push(new Uint8Array(chunk)); } });
  session(B, 23);
  await stream;
  assert.equal(await new Blob(chunks).text(), 'A captured bytes');
  assert.deepEqual(calls, [`${A}/api/book/41.txt`, `${A}/api/book/42.txt`]);
});
