import test from 'node:test';
import assert from 'node:assert/strict';
import { isBookLoginBody, isBookLoginResponse, readBookErrorPrefix } from '../src/lib/book-auth.ts';

const encode = text => new TextEncoder().encode(text);
const bookUrl = 'https://books.test/api/book/17.epub';

test('only HTTP401 or a recognized same-server login destination is authentication', () => {
  const response = (status, url = bookUrl, location) => ({ status, url, headers: new Headers(location ? { location } : {}) });
  assert.equal(isBookLoginResponse(response(401), bookUrl), true);
  assert.equal(isBookLoginResponse(response(403), bookUrl), false);
  assert.equal(isBookLoginResponse(response(302, bookUrl, '/login?next=/api/book/17.epub'), bookUrl), true);
  assert.equal(isBookLoginResponse(response(200, 'https://books.test/login'), bookUrl), true);
  assert.equal(isBookLoginResponse(response(302, bookUrl, 'https://other.test/login'), bookUrl), false);
  assert.equal(isBookLoginResponse(response(200, 'https://other.test/login'), bookUrl), false);
  assert.equal(isBookLoginResponse(response(302, bookUrl, '/maintenance'), bookUrl), false);
  assert.equal(isBookLoginResponse(response(206), bookUrl), false);
});

test('explicit login JSON and password forms qualify, generic errors and real text books do not', () => {
  const json = encode('{"err":"user.need_login","msg":"请先登录"}');
  const form = encode('<html><form method="post" action="/api/user/sign_in"><input type="password"></form></html>');
  assert.equal(isBookLoginBody(json, 'epub'), true);
  assert.equal(isBookLoginBody(form, 'pdf'), true);
  assert.equal(isBookLoginBody(encode('<html>Please login</html>'), 'pdf'), false);
  assert.equal(isBookLoginBody(encode('{"err":"permission.denied"}'), 'epub'), false);
  assert.equal(isBookLoginBody(encode('<html>Bad gateway</html>'), 'pdf'), false);
  assert.equal(isBookLoginBody(form, 'html'), false);
  assert.equal(isBookLoginBody(json, 'json'), false);
  assert.equal(isBookLoginBody(json, 'azw3'), true);
  assert.equal(isBookLoginBody(json, 'pdb'), true);
  assert.equal(isBookLoginBody(encode('{"err":"Book title"}'), 'azw3'), false);
  const title = new Uint8Array(128);
  title.set(json);
  title.set(encode('BOOKMOBI'), 60);
  assert.equal(isBookLoginBody(title, 'azw3'), false);
  assert.equal(isBookLoginBody(encode('<form action="/login"><input data-type="password" type="text"></form>'), 'epub'), false);
  assert.equal(isBookLoginBody(encode('<form action="javascript:/login"><input type="password"></form>'), 'epub'), false);
  assert.equal(isBookLoginBody(encode('%PDF-1.7\n<form action="/login"><input type="password"></form>'), 'pdf'), false);
  const legacyPage = new Uint8Array([...encode('<html><form action="/login"><input type="password">'), 0xff, 0xfe, ...encode('</form></html>')]);
  assert.equal(isBookLoginBody(legacyPage, 'pdf'), true);
});

test('error-body inspection keeps only 4KiB and disposes an oversized response', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20_000).fill(65)); },
    cancel() { cancelled = true; },
  }));
  const prefix = await readBookErrorPrefix(response);
  assert.equal(prefix.length, 4096);
  assert.ok(cancelled);
});
