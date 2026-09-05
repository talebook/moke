import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OnlineReadingError,
  onlineReadingErrorMessage,
  resolveTalebookOnlineSource,
} from '../src/lib/online-reading.ts';

const SERVER = 'https://books.example';
const BOOK_ID = '42';
const REVISION = 'abc-123';
const SOURCE = `${SERVER}/read/resource/${BOOK_ID}.epub?revision=${REVISION}`;
const BOOTSTRAP = `${SERVER}/api/book/${BOOK_ID}/reader-bootstrap?engine=readest`;

function fakeResponse({
  status = 200,
  url,
  contentType = 'application/json',
  headers = {},
  body = '',
  redirected = false,
}) {
  const response = new Response(body, {
    status,
    headers: { 'content-type': contentType, ...headers },
  });
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  Object.defineProperty(response, 'redirected', { configurable: true, value: redirected });
  return response;
}

function bootstrapPayload(resourceUrl = `/read/resource/${BOOK_ID}.epub?revision=${REVISION}`) {
  return {
    err: 'ok',
    schema: 'talebook.reader.bootstrap.v1',
    engine: 'readest',
    book: { id: Number(BOOK_ID), format: 'epub', revision: REVISION },
    resource: {
      kind: 'authorized-epub-url',
      url: resourceUrl,
      mime: 'application/epub+zip',
      range: true,
    },
  };
}

function bootstrapResponse(payload = bootstrapPayload()) {
  return fakeResponse({ url: BOOTSTRAP, body: JSON.stringify(payload) });
}

function headResponse(overrides = {}) {
  return fakeResponse({
    url: SOURCE,
    contentType: 'application/epub+zip',
    headers: {
      'content-length': '10485760',
      'accept-ranges': 'bytes',
      etag: '"epub-one"',
      ...overrides,
    },
  });
}

test('online source bootstrap is strict and preflights without downloading a body', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? bootstrapResponse() : headResponse();
  };

  const source = await resolveTalebookOnlineSource(request, SERVER, BOOK_ID);
  assert.deepEqual(source, {
    kind: 'talebook-online',
    url: SOURCE,
    format: 'epub',
    mimeType: 'application/epub+zip',
    revision: REVISION,
    etag: '"epub-one"',
    size: 10485760,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, BOOTSTRAP);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.maxRedirections, 0);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].url, SOURCE);
  assert.equal(calls[1].init.method, 'HEAD');
  assert.equal(calls[1].init.headers['Accept-Encoding'], 'identity');
});

test('bootstrap cannot authorize a different origin, book, path, query or MIME', async () => {
  const invalidPayloads = [
    bootstrapPayload(`https://evil.example/read/resource/${BOOK_ID}.epub?revision=${REVISION}`),
    bootstrapPayload(`/read/resource/41.epub?revision=${REVISION}`),
    bootstrapPayload(`/api/book/${BOOK_ID}.epub?revision=${REVISION}`),
    bootstrapPayload(`/read/resource/${BOOK_ID}.epub?revision=${REVISION}&url=https://evil.example`),
    { ...bootstrapPayload(), resource: { ...bootstrapPayload().resource, mime: 'text/html' } },
    { ...bootstrapPayload(), resource: { ...bootstrapPayload().resource, range: false } },
    { ...bootstrapPayload(), book: { id: 41, format: 'epub', revision: REVISION } },
  ];

  for (const payload of invalidPayloads) {
    await assert.rejects(
      resolveTalebookOnlineSource(async () => bootstrapResponse(payload), SERVER, BOOK_ID),
      (error) => error instanceof OnlineReadingError && error.code === 'online.response_invalid',
    );
  }
});

test('redirects and invalid current server origins fail closed', async () => {
  await assert.rejects(
    resolveTalebookOnlineSource(
      async () => fakeResponse({
        status: 302,
        url: `${SERVER}/login`,
        redirected: true,
      }),
      SERVER,
      BOOK_ID,
    ),
    (error) => error instanceof OnlineReadingError && error.code === 'online.response_invalid',
  );

  for (const invalidServer of [
    'file:///books',
    'https://user:secret@books.example',
    'https://books.example/subpath',
    'https://books.example?token=secret',
  ]) {
    await assert.rejects(
      resolveTalebookOnlineSource(async () => bootstrapResponse(), invalidServer, BOOK_ID),
      (error) => error instanceof OnlineReadingError && error.code === 'online.response_invalid',
    );
  }
});

test('old servers and permission errors produce actionable stable errors', async () => {
  await assert.rejects(
    resolveTalebookOnlineSource(
      async () => fakeResponse({ status: 404, url: BOOTSTRAP, body: 'missing' }),
      SERVER,
      BOOK_ID,
    ),
    (error) => error instanceof OnlineReadingError && error.code === 'online.server_unsupported',
  );

  await assert.rejects(
    resolveTalebookOnlineSource(
      async () => fakeResponse({
        status: 403,
        url: BOOTSTRAP,
        body: JSON.stringify({ err: 'user.no_permission' }),
      }),
      SERVER,
      BOOK_ID,
    ),
    (error) => error instanceof OnlineReadingError && error.code === 'online.permission_denied',
  );

  assert.match(onlineReadingErrorMessage(new OnlineReadingError('online.server_unsupported')), /更新服务器|下载后阅读/);
  assert.match(onlineReadingErrorMessage(new OnlineReadingError('online.permission_denied')), /权限|下载/);
});

test('preflight requires exact EPUB MIME, Range, size, ETag and stable URL', async () => {
  const cases = [
    [headResponse({ 'accept-ranges': 'none' }), 'online.range_unsupported'],
    [headResponse({ 'content-length': '0' }), 'online.response_invalid'],
    [headResponse({ etag: '' }), 'online.response_invalid'],
    [headResponse({ 'content-encoding': 'gzip' }), 'online.response_invalid'],
    [headResponse({ 'content-type': 'text/html' }), 'online.mime_invalid'],
    [fakeResponse({ status: 409, url: SOURCE, contentType: 'text/html' }), 'online.resource_changed'],
  ];

  for (const [head, code] of cases) {
    let call = 0;
    await assert.rejects(
      resolveTalebookOnlineSource(async () => (++call === 1 ? bootstrapResponse() : head), SERVER, BOOK_ID),
      (error) => error instanceof OnlineReadingError && error.code === code,
    );
  }
});

test('aborted bootstrap and network failures stay retryable without leaking raw errors', async () => {
  await assert.rejects(
    resolveTalebookOnlineSource(async () => {
      throw new Error('https://user:password@private.example');
    }, SERVER, BOOK_ID),
    (error) => error instanceof OnlineReadingError && error.code === 'online.network' && !error.message.includes('password'),
  );
  assert.doesNotMatch(onlineReadingErrorMessage(new Error('secret-token')), /secret-token/);
});
