import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { useServerStore } from '../src/lib/store/server.ts';
import { validateDownloadedBookHeader } from '../src/lib/offline-book-core.ts';
import { MokeApiError } from '../src/lib/api-core.ts';
import { useDebugLogStore } from '../src/lib/debug-log.ts';

process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
const { streamBookDownload, downloadBookBlob } = await import('../src/lib/api.ts');
useServerStore.setState({ serverUrl: 'https://books.test' });

const encode = value => new TextEncoder().encode(value);
function mobiBytes() {
  const bytes = new Uint8Array(128);
  bytes.set(encode('Example book'));
  bytes.set(encode('BOOKMOBI'), 60);
  return bytes;
}

for (const [label, body] of [
  ['HTML login page', '<!doctype html><html><body>Please login</body></html>'],
  ['JSON login error', JSON.stringify({ err: 'user.need_login', msg: '请先登录' })],
]) {
  for (const format of ['epub', 'pdf', 'azw3']) {
    test(`HTTP 200 ${label} cannot become a downloaded ${format}`, async t => {
      t.mock.method(globalThis, 'fetch', async () => new Response(body));
      const expected = label.startsWith('JSON')
        ? error => error instanceof MokeApiError && error.code === 'user.need_login'
        : /book.download.invalid_response/;
      await assert.rejects(streamBookDownload('1', format, { write: async () => {} }), expected);
      await assert.rejects(downloadBookBlob('1', format), expected);
    });
  }
}

test('MOBI-family download filtering preserves known and opaque binary variants', async t => {
  for (const format of ['mobi', 'azw', 'azw3', 'prc', 'pdb']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(mobiBytes()));
    const chunks = [];
    assert.equal((await streamBookDownload('1', format, { write: async data => chunks.push(data) })).size, 128);
    assert.equal((await downloadBookBlob('1', format)).size, 128);
  }
  // Downloading is not a Reader format-support check. A previously accepted
  // opaque variant must not fail just because its identifier is not known.
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(128)));
  assert.equal((await streamBookDownload('1', 'azw3', { write: async () => {} })).size, 128);
});

test('resumed response starts in book content and must not be treated as a new MOBI header', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.get('Range'), 'bytes=100-');
    return new Response(new Uint8Array(28), { status: 206, headers: { 'content-range': 'bytes 100-127/128' } });
  });
  assert.equal((await streamBookDownload('1', 'azw3', {
    resumeFrom: 100, write: async () => {},
  })).size, 128);
});

test('legitimate plain text, HTML, XML and JSON publications are preserved', async t => {
  for (const [format, body] of [
    ['txt', '{这是一篇小说}'], ['html', '<html><body>Book</body></html>'],
    ['fb2', '<?xml version="1.0"?><FictionBook/>'], ['json', '{"title":"Book"}'],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    assert.equal((await downloadBookBlob('1', format)).size, encode(body).length);
  }
});


test('a truncated HTTP 200 error document is rejected before the generic incomplete error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"err":"user.need_login"}', { headers: { 'content-length': '1000' } }));
  await assert.rejects(streamBookDownload('1', 'azw3', { write: async () => {} }), error => error instanceof MokeApiError && error.code === 'user.need_login');
});

test('an explicit short login envelope remains authentication when the body stream later fails', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (sent) controller.error(new TypeError('error decoding response body'));
      else { sent = true; controller.enqueue(encode('{"err":"user.need_login"}')); }
    } }));
  });
  const expected = error => error instanceof MokeApiError && error.code === 'user.need_login';
  await assert.rejects(streamBookDownload('1', 'azw3', { write: async () => {} }), expected);
  await assert.rejects(downloadBookBlob('1', 'azw3'), expected);
});


test('stream downloads can pin their captured server instead of a changed global store', async t => {
  useServerStore.setState({ serverUrl: 'https://other.test' });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://original.test/api/book/1.azw3');
    return new Response(mobiBytes());
  });
  await streamBookDownload('1', 'azw3', { serverUrl: 'https://original.test', write: async () => {} });
});

test('an HTML error remains detectable when the 4 KiB window splits a Chinese character', async t => {
  const body = '<html>' + 'a'.repeat(4089) + '中文登录页面</html>';
  assert.equal(new TextDecoder().decode(encode(body).subarray(0, 4096)).at(-1), '\ufffd');
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  await assert.rejects(downloadBookBlob('1', 'pdf'), /book.download.invalid_response/);
  await assert.rejects(streamBookDownload('1', 'pdf', { write: async () => {} }), /book.download.invalid_response/);
});

test('an incomplete MOBI header may have a JSON-looking title without losing its resumable partial', () => {
  const title = encode('{"err":"Book title"}');
  assert.doesNotThrow(() => validateDownloadedBookHeader(title, 'azw3', false));
  const complete = mobiBytes();
  complete.set(title);
  assert.doesNotThrow(() => validateDownloadedBookHeader(complete, 'azw3'));
  assert.throws(() => validateDownloadedBookHeader(title, 'azw3'), /book.download.invalid_response/);
});

test('HTML or JSON error starts remain recognizable before binary and non-UTF8 bytes', () => {
  const badStarts = [
    encode('<html>Please login</html>'),
    encode('<?xml version="1.0"?>\n<!-- gateway -->\n<html>Please login</html>'),
    encode('{"err":"permission.denied"}'),
  ];
  for (const start of badStarts) {
    for (const suffix of [new Uint8Array([0, 0xff, 0xfe]), mobiBytes()]) {
      const body = new Uint8Array(start.length + suffix.length);
      body.set(start);
      body.set(suffix, start.length);
      for (const format of ['pdf', 'epub', 'azw3', 'prc']) {
        assert.throws(() => validateDownloadedBookHeader(body, format), /book.download.invalid_response/);
      }
    }
  }
  assert.throws(() => validateDownloadedBookHeader(encode('<html>login'), 'azw3', false), /book.download.invalid_response/);
});

test('known Palm and Topaz headers preserve JSON-looking titles and existing format variants', () => {
  for (const signature of ['BOOKMOBI', 'TEXtREAd']) {
    // A bounded header fixture, not a claim that these bytes form a full PalmDB.
    const header = new Uint8Array(68).fill(32);
    header.set(encode('{"title":"Book"}'));
    header.set(encode(signature), 60);
    for (const format of ['mobi', 'azw', 'azw3', 'prc', 'pdb']) {
      assert.doesNotThrow(() => validateDownloadedBookHeader(header, format));
      assert.doesNotThrow(() => validateDownloadedBookHeader(header.slice(0, 20), format, false));
    }
  }
  const topaz = new Uint8Array([84, 80, 90, 48, 0, 0xff]);
  assert.doesNotThrow(() => validateDownloadedBookHeader(topaz, 'azw'));
});

test('leading HTML comments are scanned without ambiguous repeated matches', async t => {
  const comments = '<!-- header -->\n'.repeat(200);
  t.mock.method(globalThis, 'fetch', async () => new Response(comments + '<html>Please login</html>'));
  await assert.rejects(downloadBookBlob('1', 'pdf'), /book.download.invalid_response/);
  await assert.rejects(streamBookDownload('1', 'pdf', { write: async () => {} }), /book.download.invalid_response/);
  const incompleteComments = encode('<!--' + '--><!--'.repeat(580));
  assert.doesNotThrow(() => validateDownloadedBookHeader(incompleteComments, 'pdf'));
});

for (const [label, status, body, headers, url] of [
  ['HTTP 401', 401, 'Unauthorized', {}, ''],
  ['HTTP 403 with login code', 403, '{"err":"user.need_login"}', { 'content-type': 'application/json' }, ''],
  ['HTTP 200 login form', 200, '<html><form action="/login"><input type="password"></form></html>', { 'content-type': 'text/html' }, ''],
  ['manual login redirect', 302, '', { location: '/login?next=/api/book/1.epub' }, ''],
  ['followed login redirect', 200, '<html>Login</html>', {}, 'https://books.test/login'],
]) {
  test(`${label} preserves a typed login error across Blob and stream downloads`, async t => {
    t.mock.method(globalThis, 'fetch', async () => {
      const response = new Response(body, { status, headers });
      if (url) Object.defineProperty(response, 'url', { value: url });
      return response;
    });
    const expected = error => error instanceof MokeApiError
      && error.code === 'user.need_login' && error.status === status;
    await assert.rejects(downloadBookBlob('1', 'epub', { serverUrl: 'https://books.test' }), expected);
    await assert.rejects(streamBookDownload('1', 'epub', {
      serverUrl: 'https://books.test', write: async () => {},
    }), expected);
  });
}

test('a genuine permission denial does not become a login error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"err":"permission.denied"}', {
    status: 403, headers: { 'content-type': 'application/json' },
  }));
  await assert.rejects(downloadBookBlob('1', 'epub'), /http\.403/);
  await assert.rejects(streamBookDownload('1', 'epub', { write: async () => {} }), /http\.403/);
});

test('a failed TXT or JSON request still recognizes the server login envelope', async t => {
  for (const format of ['txt', 'html', 'json']) {
    t.mock.method(globalThis, 'fetch', async () => new Response('{"err":"user.need_login"}', { status: 403 }));
    const expected = error => error instanceof MokeApiError && error.code === 'user.need_login';
    await assert.rejects(downloadBookBlob('1', format), expected);
    await assert.rejects(streamBookDownload('1', format, { write: async () => {} }), expected);
    t.mock.method(globalThis, 'fetch', async () => new Response('{"err":"permission.denied"}', { status: 403 }));
    await assert.rejects(downloadBookBlob('1', format), /http\.403/);
  }
});

test('a late unauthorized response after cancellation remains cancelled', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.signal.aborted, true);
    return new Response('Unauthorized', { status: 401 });
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloadBookBlob('1', 'epub', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(streamBookDownload('1', 'epub', {
    signal: controller.signal, write: async () => {},
  }), { name: 'AbortError' });
});

test('a 206 body decoding failure preserves the written offset and reports response bytes separately', async t => {
  const written = [];
  const transfers = [];
  const offset = 87717;
  const added = 43830;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.get('range'), `bytes=${offset}-`);
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) controller.error(new TypeError('error decoding response body'));
        else { sent = true; controller.enqueue(new Uint8Array(added)); }
      },
    }), { status: 206, headers: {
      'content-type': 'application/epub+zip', 'content-length': '3105518',
      'content-range': 'bytes 87717-3193234/3193235',
    } });
  });
  await assert.rejects(streamBookDownload('17', 'epub', {
    resumeFrom: offset, write: async chunk => written.push(chunk),
    onTransfer: received => transfers.push(received),
  }), /book.download.transfer_failed/);
  assert.equal(written.reduce((size, chunk) => size + chunk.length, 0), added);
  assert.equal(transfers.at(-1), offset + added);
  const log = useDebugLogStore.getState().logs.filter(entry => entry.tag === 'download').at(-1);
  const detail = JSON.parse(log.detail);
  assert.equal(detail.receivedBytes, added);
  assert.equal(detail.expectedBytes, 3105518);
  assert.equal(detail.resumeOffset, offset);
  assert.equal(detail.fileReceivedBytes, offset + added);
});
