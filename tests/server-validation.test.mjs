import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
const { validateServerConnection, checkWelcomeRequirement } = await import('../src/lib/api.ts');
const { readConnectionWelcome, checkSavedServer } = await import('../src/lib/server-connection.ts');

test('one explicit connection probe accepts the supported Talebook states', async context => {
  for (const [err, status] of [['ok', 200], ['not_installed', 200], ['user.need_login', 200], ['not_invited', 200], ['user.need_login', 401], ['not_invited', 403]]) {
    const calls = [];
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push([String(url), init.credentials]);
      return Response.json({ err }, { status });
    });
    assert.deepEqual(await validateServerConnection('https://books.test'), { err: 'ok' });
    assert.deepEqual(calls, [['https://books.test/api/user/info', 'include']]);
  }
});

test('HTTP failures cannot use a known Talebook state to bypass the connection probe', async context => {
  for (const [err, status] of [
    ['ok', 503], ['not_installed', 503], ['user.need_login', 503], ['not_invited', 503],
    ['not_installed', 401], ['not_invited', 401], ['user.need_login', 403],
  ]) {
    const requests = [];
    context.mock.method(globalThis, 'fetch', async url => {
      requests.push(String(url));
      assert.equal(String(url).endsWith('/api/user/info'), true, 'failed validation must not reach welcome');
      return Response.json({ err, msg: 'connection HTTP failure' }, { status });
    });
    const result = await validateServerConnection('https://books.test');
    assert.equal(result.err, err === 'ok' ? `http.${status}` : err);
    await assert.rejects(checkSavedServer('https://books.test', {
      validate: validateServerConnection, welcome: checkWelcomeRequirement,
    }, new AbortController().signal), /connection HTTP failure/);
    assert.deepEqual(requests, Array(2).fill('https://books.test/api/user/info'));
  }
});

test('failed connection probes return actionable errors after a single request', async context => {
  for (const [response, expectedCode, expectedMessage] of [
    [() => { throw new Error('fixture unreachable'); }, 'network.error', /检查地址和网络/],
    [() => new Response('<html>gateway</html>', { headers: { 'content-type': 'text/html' } }), 'server.invalid_response', /不像是可用的 Talebook/],
    [() => Response.json({ err: 'server.unavailable', msg: '服务暂不可用' }, { status: 503 }), 'server.unavailable', /服务暂不可用/],
    [() => Response.json({ err: 'fixture.invalid', msg: '请确认服务器' }), 'fixture.invalid', /请确认服务器/],
  ]) {
    let calls = 0;
    context.mock.method(globalThis, 'fetch', async () => { calls++; return response(); });
    const result = await validateServerConnection('https://books.test');
    assert.equal(result.err, expectedCode);
    assert.match(result.msg, expectedMessage);
    assert.equal(calls, 1);
  }
});

test('connection probe cancellation preserves its reason and does not retry', async context => {
  const controller = new AbortController();
  const reason = new Error('连接超时，请重试');
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(init.signal, controller.signal);
    controller.abort(reason);
    throw reason;
  });
  await assert.rejects(validateServerConnection('https://books.test', controller.signal), error => error === reason);
  assert.equal(calls, 1);
});

test('welcome requirements accept only explicit open or access-required states, including not_invited', async context => {
  for (const [err, needsAccessCode] of [['ok', true], ['free', false], ['not_invited', true]]) {
    const calls = [];
    const controller = new AbortController();
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push([String(url), init.credentials, init.signal]);
      return Response.json({ err, msg: `fixture ${err}` });
    });
    assert.deepEqual(readConnectionWelcome({ err, msg: `fixture ${err}` }), { err: 'ok', msg: `fixture ${err}`, needsAccessCode });
    assert.deepEqual(await checkWelcomeRequirement('https://books.test', controller.signal), { err: 'ok', msg: `fixture ${err}`, needsAccessCode });
    assert.deepEqual(calls, [['https://books.test/api/welcome', 'include', controller.signal]]);
  }
});

test('welcome requirements keep unknown codes, failed HTTP responses and malformed bodies as failures', async context => {
  for (const [response, expectedCode] of [
    [() => Response.json({ err: 'server.busy', msg: '服务繁忙' }), 'server.busy'],
    [() => Response.json({ err: 'not_installed' }), 'not_installed'],
    [() => Response.json({ err: 'not_invited' }, { status: 403 }), 'not_invited'],
    [() => Response.json({ err: 'not_invited' }, { status: 503 }), 'not_invited'],
    [() => Response.json({ err: 'free' }, { status: 403 }), 'http.403'],
    [() => Response.json({ err: 'ok' }, { status: 500 }), 'http.500'],
    [() => Response.json({ err: 0 }), 'server.invalid_response'],
    [() => Response.json({}), 'server.invalid_response'],
    [() => Response.json(['not_invited']), 'server.invalid_response'],
    [() => new Response('<html>not Talebook</html>', { headers: { 'content-type': 'text/html' } }), 'server.invalid_response'],
  ]) {
    let calls = 0;
    context.mock.method(globalThis, 'fetch', async () => { calls++; return response(); });
    const result = await checkWelcomeRequirement('https://books.test');
    assert.equal(result.err, expectedCode);
    assert.equal(result.needsAccessCode, false);
    assert.equal(calls, 1);
  }
});

test('saved-server confirmation rejects failed welcome HTTP requests even with an ok or invite-state body', async context => {
  for (const [err, status] of [['ok', 503], ['free', 503], ['not_invited', 503], ['not_invited', 403]]) {
    const requests = [];
    context.mock.method(globalThis, 'fetch', async url => {
      requests.push(String(url));
      return String(url).endsWith('/api/user/info') ? Response.json({ err: 'ok' })
        : Response.json({ err, msg: 'failed welcome HTTP request' }, { status });
    });
    await assert.rejects(checkSavedServer('https://books.test', {
      validate: validateServerConnection, welcome: checkWelcomeRequirement,
    }, new AbortController().signal), /failed welcome HTTP request/);
    assert.deepEqual(requests, ['https://books.test/api/user/info', 'https://books.test/api/welcome']);
  }
});

test('an uninstalled server is recognized by HTTP 200 but cannot pass saved-server confirmation', async context => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    return Response.json({ err: 'not_installed', msg: 'server setup is incomplete' });
  });
  await assert.rejects(checkSavedServer('https://books.test', {
    validate: validateServerConnection, welcome: checkWelcomeRequirement,
  }, new AbortController().signal), /server setup is incomplete/);
  assert.deepEqual(requests, ['https://books.test/api/user/info', 'https://books.test/api/welcome']);
});

test('saved-server confirmation uses actual requests to route not_invited to access and reject unknown welcome failures', async context => {
  // The ok welcome case models the official invite-required flow: HTTP 200
  // not_invited from user/info, then HTTP 200 ok from Welcome, which bypasses
  // that gate (talebook/talebook d5d21dda160d65d29cc0c9ab8a13ae6b4deb69d2,
  // webserver/handlers/base.py:206-214 and user.py:467-477).
  for (const err of ['ok', 'free', 'not_invited', 'server.busy']) {
    const calls = [];
    const controller = new AbortController();
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push([String(url), init.credentials, init.signal]);
      return Response.json(String(url).endsWith('/api/user/info') ? { err: 'not_invited' } : { err, msg: 'fixture welcome state' });
    });
    const checking = checkSavedServer('https://books.test', {
      validate: validateServerConnection, welcome: checkWelcomeRequirement,
    }, controller.signal);
    if (err === 'server.busy') await assert.rejects(checking, /fixture welcome state/);
    else assert.equal((await checking).needsAccessCode, err !== 'free');
    assert.deepEqual(calls, ['/api/user/info', '/api/welcome'].map(path => ['https://books.test' + path, 'include', controller.signal]));
  }
});

test('welcome cancellation preserves its reason without another request or an access decision', async context => {
  const controller = new AbortController();
  const reason = new Error('访问码检查已取消');
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(init.signal, controller.signal);
    controller.abort(reason);
    throw reason;
  });
  await assert.rejects(checkWelcomeRequirement('https://books.test', controller.signal), error => error === reason);
  assert.equal(calls, 1);
});
