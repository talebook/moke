import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/import-app-module.mjs';
const { validateServerConnection } = await import('../src/lib/api.ts');

test('one explicit connection probe accepts the supported Talebook states', async context => {
  for (const [err, status] of [['ok', 200], ['not_installed', 200], ['user.need_login', 401], ['not_invited', 403]]) {
    const calls = [];
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push([String(url), init.credentials]);
      return Response.json({ err }, { status });
    });
    assert.deepEqual(await validateServerConnection('https://books.test'), { err: 'ok' });
    assert.deepEqual(calls, [['https://books.test/api/user/info', 'include']]);
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
