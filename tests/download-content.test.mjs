import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';
import { useServerStore } from '../src/lib/store/server.ts';
import { validateDownloadedBookHeader } from '../src/lib/offline-book-core.ts';

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
      await assert.rejects(streamBookDownload('1', format, { write: async () => {} }), /book.download.invalid_response/);
      await assert.rejects(downloadBookBlob('1', format), /book.download.invalid_response/);
    });
  }
}

test('MOBI-family headers accept binary data and reject an invalid PalmDB signature', async t => {
  for (const format of ['mobi', 'azw', 'azw3']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(mobiBytes()));
    const chunks = [];
    assert.equal((await streamBookDownload('1', format, { write: async data => chunks.push(data) })).size, 128);
    assert.equal((await downloadBookBlob('1', format)).size, 128);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(128)));
  await assert.rejects(streamBookDownload('1', 'azw3', { write: async () => {} }), /book.mobi.invalid/);
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
  await assert.rejects(streamBookDownload('1', 'azw3', { write: async () => {} }), /book.download.invalid_response/);
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

test('leading HTML comments are scanned without ambiguous repeated matches', async t => {
  const comments = '<!-- header -->\n'.repeat(200);
  t.mock.method(globalThis, 'fetch', async () => new Response(comments + '<html>Please login</html>'));
  await assert.rejects(downloadBookBlob('1', 'pdf'), /book.download.invalid_response/);
  await assert.rejects(streamBookDownload('1', 'pdf', { write: async () => {} }), /book.download.invalid_response/);
  const incompleteComments = encode('<!--' + '--><!--'.repeat(580));
  assert.doesNotThrow(() => validateDownloadedBookHeader(incompleteComments, 'pdf'));
});
