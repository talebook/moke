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
const LEGACY_SOURCE = `${SERVER}/api/book/${BOOK_ID}.epub`;
const BOOTSTRAP = `${SERVER}/api/book/${BOOK_ID}/reader-bootstrap?engine=readest`;
const LEGACY_READ = `${SERVER}/read/${BOOK_ID}`;

test('a same-server login redirect requests login without following or authorizing the redirect', async () => {
  let calls = 0;
  await assert.rejects(resolveTalebookOnlineSource(async () => {
    calls += 1;
    return fakeResponse({ status: 302, url: BOOTSTRAP, headers: { location: '/login' } });
  }, SERVER, BOOK_ID), error => error instanceof OnlineReadingError && error.code === 'online.auth_required');
  assert.equal(calls, 1);
});

test('legacy Range probes distinguish authentication documents from unsupported ranges and permissions', async () => {
  for (const [status, contentType, body, expected] of [
    [200, 'application/json', '{"err":"user.need_login"}', 'online.auth_required'],
    [403, 'application/json', '{"err":"user.need_login"}', 'online.auth_required'],
    [200, 'text/html', '<form action="/login"><input type="password"></form>', 'online.auth_required'],
    [403, 'application/json', '{"err":"permission.denied"}', 'online.permission_denied'],
    [200, 'application/epub+zip', new Uint8Array(1), 'online.range_unsupported'],
  ]) {
    const request = async (url, init) => {
      if (url === BOOTSTRAP) return fakeResponse({ status: 404, url: BOOTSTRAP, contentType: 'text/html', body: 'Not found' });
      if (url === LEGACY_READ) return legacyReadResponse();
      if (init?.method === 'HEAD') return headResponse({}, LEGACY_SOURCE);
      return fakeResponse({ status, url: LEGACY_SOURCE, contentType, body });
    };
    await assert.rejects(resolveTalebookOnlineSource(request, SERVER, BOOK_ID),
      error => error instanceof OnlineReadingError && error.code === expected,
      `${status}: ${expected}`);
  }
});

test('HEAD error documents cannot hide a login challenge on the legacy Range route', async (t) => {
  for (const [headStatus, headMime] of [[200, 'text/html'], [200, 'application/json'], [403, 'application/json']]) {
    for (const [status, contentType, body] of [
      [200, 'application/json', '{"err":"user.need_login"}'],
      [403, 'application/json', '{"err":"user.need_login"}'],
      [200, 'text/html', '<form action="/login"><input type="password"></form>'],
    ]) {
      await t.test(`HEAD ${headStatus} ${headMime}, GET ${status} ${contentType}`, async () => {
        const calls = [];
        const request = async (url, init) => {
          calls.push({ url, init });
          if (url === BOOTSTRAP) return fakeResponse({ status: 404, url, contentType: 'text/html', body: 'missing' });
          if (url === LEGACY_READ) return legacyReadResponse();
          if (init.method === 'HEAD') return fakeResponse({ status: headStatus, url, contentType: headMime });
          return fakeResponse({ status, url, contentType, body });
        };
        await assert.rejects(resolveTalebookOnlineSource(request, SERVER, BOOK_ID), error =>
          error.code === 'online.auth_required' && error.stage === 'range-status');
        assert.equal(calls.length, 4);
        assert.equal(calls[3].url, LEGACY_SOURCE);
        assert.equal(calls[3].init.headers.Range, 'bytes=0-0');
      });
    }
  }
});

test('a non-login Range response preserves a rejected HEAD without authorizing Reader', async () => {
  for (const [headStatus, headMime, code] of [
    [200, 'text/html', 'online.mime_invalid'],
    [403, 'application/json', 'online.permission_denied'],
  ]) {
    for (const validRange of [false, true]) {
      let calls = 0;
      const request = async (url, init) => {
        calls += 1;
        if (url === BOOTSTRAP) return bootstrapResponse();
        if (init.method === 'HEAD') return fakeResponse({ status: headStatus, url, contentType: headMime });
        return validRange ? rangeResponse() : fakeResponse({ status: 403, url, body: '{"err":"user.no_permission"}' });
      };
      await assert.rejects(resolveTalebookOnlineSource(request, SERVER, BOOK_ID), error =>
        error.code === (validRange ? code : 'online.permission_denied'));
      assert.equal(calls, 3);
    }
  }
});

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

function legacyReadResponse(url = LEGACY_READ) {
  return fakeResponse({ url, contentType: 'text/html', body: '<html><body>Reader</body></html>' });
}

test('legacy reading permission is checked before any download, even if downloads would allow guests', async () => {
  for (const [status, contentType, body, headers, code] of [
    [302, 'text/html', '', { location: '/login' }, 'online.auth_required'],
    [401, 'text/html', '', {}, 'online.auth_required'],
    [200, 'text/html', '<form action="/login"><input type="password"></form>', {}, 'online.auth_required'],
    [200, 'application/json', '{"err":"user.need_login"}', {}, 'online.auth_required'],
    [403, 'text/html', 'Forbidden', {}, 'online.permission_denied'],
    [404, 'text/html', 'Missing', {}, 'online.not_found'],
    [200, 'application/json', '{"err":"ok"}', {}, 'online.response_invalid'],
    [200, 'text/html', '', {}, 'online.response_invalid'],
    [302, 'text/html', '', { location: 'https://other.example/login' }, 'online.response_invalid'],
  ]) {
    const calls = [];
    const request = async (url, init) => {
      calls.push({ url, init });
      if (url === BOOTSTRAP) return fakeResponse({ status: 404, url, contentType: 'text/html', body: 'missing' });
      if (url === LEGACY_READ) return fakeResponse({ status, url, contentType, body, headers });
      // A publicly downloadable book must never override a reading rejection.
      return rangeResponse({ url: LEGACY_SOURCE });
    };
    await assert.rejects(resolveTalebookOnlineSource(request, SERVER, BOOK_ID), error => error.code === code);
    assert.deepEqual(calls.map(call => call.url), [BOOTSTRAP, LEGACY_READ]);
    assert.equal(calls[1].init.credentials, 'include');
    assert.equal(calls[1].init.redirect, 'manual');
    assert.equal(calls[1].init.maxRedirections, 0);
  }
});

test('a successful legacy reading check consumes only a bounded prefix and cancels the page', async () => {
  let cancelled = false;
  let pageBytes = 0;
  const request = async (url, init) => {
    if (url === BOOTSTRAP) return fakeResponse({ status: 404, url, contentType: 'text/html', body: 'missing' });
    if (url === LEGACY_READ) {
      const response = new Response(new ReadableStream({
        pull(controller) {
          const chunk = new Uint8Array(4096).fill(0x20);
          chunk.set(new TextEncoder().encode('<html>'));
          pageBytes += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    return init.method === 'HEAD' ? headResponse({}, LEGACY_SOURCE) : rangeResponse({ url });
  };
  assert.equal((await resolveTalebookOnlineSource(request, SERVER, BOOK_ID)).url, LEGACY_SOURCE);
  assert.equal(cancelled, true);
  assert.ok(pageBytes <= 8192, 'the reader page must not be buffered in full');
});

test('legacy reading rejects an unexpected response URL and cancels its body', async () => {
  let cancelled = false;
  const request = async (url) => {
    if (url === BOOTSTRAP) return fakeResponse({ status: 404, url, contentType: 'text/html', body: 'missing' });
    assert.equal(url, LEGACY_READ);
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'content-type': 'text/html' },
    });
    Object.defineProperty(response, 'url', { value: 'https://other.example/read/42' });
    return response;
  };
  await assert.rejects(resolveTalebookOnlineSource(request, SERVER, BOOK_ID), error =>
    error.code === 'online.response_invalid' && error.stage === 'legacy-read-url');
  assert.equal(cancelled, true);
});

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

function headResponse(overrides = {}, url = SOURCE, contentType = 'application/epub+zip') {
  return fakeResponse({
    url,
    contentType,
    headers: {
      'content-length': '10485760',
      'accept-ranges': 'bytes',
      etag: '"epub-one"',
      ...overrides,
    },
  });
}

function rangeResponse({
  status = 206,
  headers = {},
  body = new Uint8Array([0x50]),
  url = SOURCE,
  contentType = 'application/epub+zip',
} = {}) {
  return fakeResponse({
    status,
    url,
    contentType,
    headers: {
      'content-length': '1',
      'content-range': 'bytes 0-0/10485760',
      etag: '"epub-one"',
      ...headers,
    },
    body,
  });
}

test('online source bootstrap is strict and proves Range with only one body byte', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return bootstrapResponse();
    if (init?.method === 'HEAD') return headResponse();
    return rangeResponse();
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
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, BOOTSTRAP);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.maxRedirections, 0);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].url, SOURCE);
  assert.equal(calls[1].init.method, 'HEAD');
  assert.equal(calls[1].init.headers['Accept-Encoding'], 'identity');
  assert.equal(calls[2].url, SOURCE);
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(calls[2].init.headers.Range, 'bytes=0-0');
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

test('persisted equivalent origin spellings are canonicalized before preflight', async () => {
  for (const serverUrl of [
    `${SERVER}/`,
    `${SERVER}///`,
    ' HTTPS://BOOKS.EXAMPLE:443/ ',
  ]) {
    let call = 0;
    const source = await resolveTalebookOnlineSource(async (url, init) => {
      call += 1;
      if (call === 1) {
        assert.equal(url, BOOTSTRAP);
        return bootstrapResponse();
      }
      if (init?.method === 'HEAD') return headResponse();
      return rangeResponse();
    }, serverUrl, ` ${BOOK_ID} `);
    assert.equal(source.url, SOURCE);
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
      (error) =>
        error instanceof OnlineReadingError &&
        error.code === 'online.response_invalid' &&
        error.stage === 'server-url',
    );
  }
});

test('pre-bootstrap Talebook falls back to its fixed ranged EPUB route', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    if (url === BOOTSTRAP) {
      return fakeResponse({ status: 404, url: BOOTSTRAP, contentType: 'text/html', body: 'missing' });
    }
    if (url === LEGACY_READ) return legacyReadResponse();
    if (init?.method === 'HEAD') {
      return headResponse({}, LEGACY_SOURCE, 'application/octet-stream');
    }
    return rangeResponse({ url: LEGACY_SOURCE, contentType: 'application/octet-stream' });
  };

  const source = await resolveTalebookOnlineSource(request, SERVER, BOOK_ID);
  assert.deepEqual(source, {
    kind: 'talebook-online',
    url: LEGACY_SOURCE,
    format: 'epub',
    mimeType: 'application/epub+zip',
    revision: null,
    etag: '"epub-one"',
    size: 10485760,
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].url, LEGACY_READ);
  assert.equal(calls[2].url, LEGACY_SOURCE);
  assert.equal(calls[3].init.headers.Range, 'bytes=0-0');
});

test('legacy fallback never turns a Range-ignoring full response into online reading', async () => {
  const bodyRead = () => {
    throw new Error('full legacy body must not be read');
  };
  const fullResponse = rangeResponse({
    status: 200,
    url: LEGACY_SOURCE,
    contentType: 'application/octet-stream',
    headers: { 'content-length': '10485760' },
    body: new Uint8Array([0x50]),
  });
  Object.defineProperty(fullResponse, 'arrayBuffer', { value: bodyRead });
  let call = 0;

  await assert.rejects(
    resolveTalebookOnlineSource(async (url, init) => {
      call += 1;
      if (call === 1) {
        return fakeResponse({ status: 404, url: BOOTSTRAP, contentType: 'text/html' });
      }
      if (url === LEGACY_READ) return legacyReadResponse();
      if (init.method === 'HEAD') return headResponse({}, LEGACY_SOURCE, 'application/octet-stream');
      return fullResponse;
    }, SERVER, BOOK_ID),
    (error) => error instanceof OnlineReadingError && error.code === 'online.range_unsupported',
  );
  assert.equal(call, 4);
});

test('structured bootstrap and permission errors do not downgrade to the download route', async () => {
  for (const [status, body, code] of [
    [404, { err: 'book.not_found' }, 'online.not_found'],
    [403, { err: 'user.no_permission' }, 'online.permission_denied'],
  ]) {
    let calls = 0;
    await assert.rejects(
      resolveTalebookOnlineSource(
        async () => {
          calls += 1;
          return fakeResponse({ status, url: BOOTSTRAP, body: JSON.stringify(body) });
        },
        SERVER,
        BOOK_ID,
      ),
      (error) => error instanceof OnlineReadingError && error.code === code,
    );
    assert.equal(calls, 1);
  }

  assert.match(onlineReadingErrorMessage(new OnlineReadingError('online.server_unsupported')), /更新服务器|下载后阅读/);
  assert.match(onlineReadingErrorMessage(new OnlineReadingError('online.permission_denied')), /权限|下载/);
});

test('HEAD differences are tolerated only when the real Range probe is valid', async () => {
  for (const head of [
    headResponse({ 'accept-ranges': 'none' }),
    fakeResponse({ status: 405, url: SOURCE, contentType: 'text/plain' }),
  ]) {
    let call = 0;
    const source = await resolveTalebookOnlineSource(async () => {
      call += 1;
      if (call === 1) return bootstrapResponse();
      if (call === 2) return head;
      return rangeResponse();
    }, SERVER, BOOK_ID);
    assert.equal(source.size, 10485760);
    assert.equal(source.etag, '"epub-one"');
  }
});

test('preflight rejects invalid HEAD metadata before opening Reader', async () => {
  const cases = [
    [headResponse({ 'content-length': '0' }), 'online.response_invalid'],
    [headResponse({ etag: '' }), 'online.response_invalid'],
    [headResponse({ 'content-encoding': 'gzip' }), 'online.response_invalid'],
    [headResponse({ 'content-type': 'text/html' }), 'online.mime_invalid'],
    [fakeResponse({ status: 409, url: SOURCE, contentType: 'text/html' }), 'online.resource_changed'],
  ];

  for (const [head, code] of cases) {
    let call = 0;
    await assert.rejects(
      resolveTalebookOnlineSource(async () => {
        call += 1;
        if (call === 1) return bootstrapResponse();
        if (call === 2) return head;
        return rangeResponse();
      }, SERVER, BOOK_ID),
      (error) => error instanceof OnlineReadingError && error.code === code,
    );
  }
});

test('preflight rejects upstream 200, 416 and malformed 206 range responses', async () => {
  const cases = [
    [rangeResponse({ status: 200, body: new Uint8Array(10485760) }), 'online.range_unsupported'],
    [rangeResponse({ status: 416, headers: { 'content-range': 'bytes */10485760' }, body: '' }), 'online.resource_changed'],
    [rangeResponse({ headers: { 'content-range': 'bytes 1-1/10485760' } }), 'online.response_invalid'],
    [rangeResponse({ headers: { 'content-length': '2' } }), 'online.response_invalid'],
    [rangeResponse({ headers: { etag: '"epub-two"' } }), 'online.resource_changed'],
  ];

  for (const [probe, code] of cases) {
    let call = 0;
    await assert.rejects(
      resolveTalebookOnlineSource(async () => {
        call += 1;
        if (call === 1) return bootstrapResponse();
        if (call === 2) return headResponse();
        return probe;
      }, SERVER, BOOK_ID),
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

test('online preflight retries a transient gateway failure and revalidates all metadata', async () => {
  let attempts = 0;
  const request = async (url, init) => {
    if (url === BOOTSTRAP) {
      attempts += 1;
      if (attempts === 1) return fakeResponse({ url, status: 503 });
      return bootstrapResponse();
    }
    if (init.method === 'HEAD') return headResponse();
    return fakeResponse({ url: SOURCE, status: 206, contentType: 'application/epub+zip',
      headers: { 'content-length': '1', 'content-range': 'bytes 0-0/10485760', etag: '"epub-one"' },
      body: new Uint8Array([0]),
    });
  };
  const result = await resolveTalebookOnlineSource(request, SERVER, BOOK_ID);
  assert.equal(result.url, SOURCE);
  assert.equal(attempts, 2);
});

test('cancelling an online preflight prevents another attempt', async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = resolveTalebookOnlineSource(async () => {
    requests += 1;
    controller.abort();
    throw new TypeError('network');
  }, SERVER, BOOK_ID, controller.signal);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests, 1);
});

for (const [failedStage, expectedCalls] of [['bootstrap-status', 1], ['head-status', 2], ['range-status', 3]]) {
  for (const status of [401, 302, 307]) {
    test(`auth diagnostics preserve ${failedStage} HTTP ${status} without retry or downgrade`, async () => {
      let calls = 0;
      const request = async (url, init) => {
        calls += 1;
        if (calls === expectedCalls) return fakeResponse({
          status, url, contentType: 'text/html',
          headers: { location: 'https://auth.example/login?token=private-value' },
          body: 'private-response-body',
        });
        if (url === BOOTSTRAP) return bootstrapResponse();
        if (init?.method === 'HEAD') return headResponse();
        throw new Error('must not continue after authorization failure');
      };
      await assert.rejects(resolveTalebookOnlineSource(request, SERVER, BOOK_ID), (error) => {
        const expectedCode = status === 401 ? 'online.auth_required' : 'online.response_invalid';
        assert.equal(error.code, expectedCode);
        assert.equal(error.stage, failedStage);
        assert.equal(error.status, status);
        assert.equal(error.message, `${expectedCode}:${failedStage}:http-${status}`);
        assert.equal(error.stack.includes('private-'), false);
        assert.equal(error.stack.includes('auth.example'), false);
        return true;
      });
      assert.equal(calls, expectedCalls);
    });
  }
}

test('HTTP 200 login envelope retains bootstrap body stage and cannot downgrade', async () => {
  let calls = 0;
  await assert.rejects(resolveTalebookOnlineSource(async () => {
    calls += 1;
    return bootstrapResponse({ err: 'user.need_login', msg: 'private-response-body' });
  }, SERVER, BOOK_ID), (error) => {
    assert.equal(error.message, 'online.auth_required:bootstrap-body:http-200');
    return true;
  });
  assert.equal(calls, 1);
});

for (const status of [301, 308]) {
  for (const legacy of [false, true]) {
    test(`one HTTP ${status} HTTPS upgrade resolves ${legacy ? 'legacy' : 'modern'} source`, async () => {
      const httpServer = SERVER.replace('https:', 'http:');
      const httpBootstrap = BOOTSTRAP.replace('https:', 'http:');
      const resource = legacy ? LEGACY_SOURCE : SOURCE;
      const calls = [];
      const result = await resolveTalebookOnlineSource(async (url, init) => {
        calls.push({ url, init });
        if (url === httpBootstrap) return fakeResponse({ status, url, headers: { location: BOOTSTRAP } });
        if (url === BOOTSTRAP) return legacy
          ? fakeResponse({ status: 404, url, contentType: 'text/html', body: 'missing' })
          : bootstrapResponse();
        if (url === LEGACY_READ) return legacyReadResponse();
        assert.equal(url, resource);
        return init.method === 'HEAD' ? headResponse({}, resource) : rangeResponse({ url: resource });
      }, `${httpServer}:80`, BOOK_ID);
      assert.equal(result.url, resource);
      assert.equal(calls.length, legacy ? 5 : 4);
      assert.equal(calls.every(({ init }) => init.maxRedirections === 0 && init.redirect === 'manual'), true);
      assert.equal(calls.at(-1).init.headers.Range, 'bytes=0-0');
    });
  }
}

for (const target of [
  'https://evil.example/api/book/42/reader-bootstrap?engine=readest',
  `${SERVER}:8443/api/book/42/reader-bootstrap?engine=readest`,
  `${SERVER}/login?engine=readest`,
  `${BOOTSTRAP}&token=private-value`,
  `${BOOTSTRAP}#fragment`,
  BOOTSTRAP.replace('https://', 'https://user:private-value@'),
  BOOTSTRAP.replace('https:', 'http:'),
  '',
]) {
  test(`unverified bootstrap upgrade stays blocked (${target.includes('private') ? 'credential case' : target})`, async () => {
    let calls = 0;
    await assert.rejects(resolveTalebookOnlineSource(async (url) => {
      calls += 1;
      return fakeResponse({ status: 308, url, headers: { location: target } });
    }, SERVER.replace('https:', 'http:'), BOOK_ID), (error) => {
      assert.equal(error.code, 'online.response_invalid');
      assert.equal(error.status, 308);
      assert.equal(error.message.includes('private-value'), false);
      assert.equal(onlineReadingErrorMessage(error).includes('登录状态已失效'), false);
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const secondStatus of [308, 401, 403]) {
  test(`HTTPS upgrade cannot follow another redirect or bypass HTTP ${secondStatus}`, async () => {
    let calls = 0;
    await assert.rejects(resolveTalebookOnlineSource(async (url) => {
      calls += 1;
      return fakeResponse({ status: calls === 1 ? 308 : secondStatus, url, headers: { location: BOOTSTRAP } });
    }, SERVER.replace('https:', 'http:'), BOOK_ID), (error) => error.status === secondStatus);
    assert.equal(calls, 2);
  });
}

test('cancellation after the redirect never sends the HTTPS follow-up', async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(resolveTalebookOnlineSource(async (url) => {
    calls += 1;
    controller.abort();
    return fakeResponse({ status: 308, url, headers: { location: BOOTSTRAP } });
  }, SERVER.replace('https:', 'http:'), BOOK_ID, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
