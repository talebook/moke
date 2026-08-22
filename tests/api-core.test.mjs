import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachSafeJsonReader,
  MokeApiError,
  buildTauriBinaryHeaders,
  buildTauriRequestInit,
  getErrorMessage,
  isAbsoluteHttpUrl,
  readApiJson,
  readJsonResponse,
  resolveAppPlatform,
} from '../src/lib/api-core.ts';

test('API 地址只接受绝对 HTTP(S) 地址', () => {
  assert.equal(isAbsoluteHttpUrl('http://192.168.1.2:8080/api/books'), true);
  assert.equal(isAbsoluteHttpUrl('https://books.example.com/api/books'), true);
  assert.equal(isAbsoluteHttpUrl('/api/books'), false);
  assert.equal(isAbsoluteHttpUrl('file:///tmp/book.epub'), false);
});

test('API 成功响应和允许的兼容错误码可以正常读取', async () => {
  const success = await readApiJson(new Response(JSON.stringify({ err: 'ok', books: [1] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  assert.deepEqual(success, { err: 'ok', books: [1] });

  const compatible = await readApiJson(
    new Response(JSON.stringify({ err: 'user.need_login' }), { status: 200 }),
    '响应无效',
    ['ok', 'user.need_login'],
  );
  assert.equal(compatible.err, 'user.need_login');
});

test('API 的 HTTP 错误保留服务端错误码、提示和状态码', async () => {
  await assert.rejects(
    () => readApiJson(new Response(JSON.stringify({ err: 'permission.denied', msg: '没有权限' }), { status: 403 })),
    (error) => {
      assert.ok(error instanceof MokeApiError);
      assert.equal(error.code, 'permission.denied');
      assert.equal(error.message, '没有权限');
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('API 的无效 JSON 和业务错误会转换成统一错误', async () => {
  await assert.rejects(
    () => readApiJson(new Response('<html>not json</html>', { status: 200 }), '不是有效响应'),
    (error) => error instanceof MokeApiError && error.code === 'server.invalid_response',
  );

  await assert.rejects(
    () => readApiJson(new Response(JSON.stringify({ err: 'book.not_found' }), { status: 200 })),
    (error) => error instanceof MokeApiError && error.code === 'book.not_found',
  );
});

test('纯文本网关错误保留真实原因，不暴露 JSON 解析异常', async () => {
  await assert.rejects(
    () => readApiJson(new Response('error code: 1033', {
      status: 530,
      headers: { 'content-type': 'text/plain' },
    })),
    (error) => {
      assert.ok(error instanceof MokeApiError);
      assert.equal(error.code, 'http.530');
      assert.equal(error.status, 530);
      assert.equal(error.message, '服务器返回 530：error code: 1033');
      assert.doesNotMatch(error.message, /JSON|ReadableStream|controller/i);
      return true;
    },
  );
});

test('成功 JSON 响应只读取一次正文，不调用 Response.json', async () => {
  const response = new Response(JSON.stringify({ err: 'ok', value: 42 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(response, 'json', {
    value: () => {
      throw new Error('不应调用 response.json()');
    },
  });

  assert.deepEqual(await readJsonResponse(response), { err: 'ok', value: 42 });
  assert.equal(response.bodyUsed, true);
});

test('共享请求层的历史 response.json 调用同样使用安全解析', async () => {
  const response = attachSafeJsonReader(new Response('error code: 1033', {
    status: 530,
    headers: { 'content-type': 'text/plain' },
  }));

  await assert.rejects(
    () => response.json(),
    (error) => error instanceof MokeApiError
      && error.code === 'http.530'
      && error.message === '服务器返回 530：error code: 1033',
  );
});

test('HTML 错误页不直接暴露，响应流读取失败转换为可理解错误', async () => {
  await assert.rejects(
    () => readJsonResponse(new Response('<html><script>secret()</script></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })),
    (error) => error instanceof MokeApiError
      && error.code === 'http.502'
      && error.message === '服务器返回 502，且响应内容无效。',
  );

  const brokenResponse = {
    ok: false,
    status: 503,
    text: async () => {
      throw new TypeError("Failed to execute 'close' on 'ReadableStreamDefaultController'");
    },
  };
  await assert.rejects(
    () => readJsonResponse(brokenResponse),
    (error) => error instanceof MokeApiError
      && error.code === 'server.response_read_failed'
      && error.message === '服务器响应读取失败，请稍后重试。'
      && !error.message.includes('ReadableStream'),
  );
});

test('need_login 未列入 okErrs 时抛 MokeApiError（会话失效场景）', async () => {
  await assert.rejects(
    () => readApiJson(
      new Response(JSON.stringify({ err: 'user.need_login', msg: '请先登录' }), { status: 200 }),
      '响应无效',
    ),
    (error) => {
      assert.ok(error instanceof MokeApiError);
      assert.equal(error.code, 'user.need_login');
      assert.equal(error.message, '请先登录');
      return true;
    },
  );
});

test('错误提示映射覆盖地址丢失、HTTP 错误和未知错误', () => {
  assert.equal(getErrorMessage(new Error('server.url.missing')), '服务器地址丢失，请重新连接书库。');
  assert.equal(getErrorMessage(new Error('http.502')), '服务器返回 502。');
  assert.equal(getErrorMessage(null, '稍后重试'), '稍后重试');
  // 未知 Error：不暴露原始（可能英文/内部）报错文本，回退到兜底文案
  assert.equal(getErrorMessage(new Error('Failed to fetch')), '操作失败，请稍后重试。');
  assert.equal(getErrorMessage(new Error('Failed to fetch'), '网络异常'), '网络异常');
  // MokeApiError 保留服务端业务提示
  assert.equal(getErrorMessage(new MokeApiError('没有权限', 'permission.denied', 403)), '没有权限');
});

test('Tauri 二进制请求显式禁用透明压缩', () => {
  const headers = buildTauriBinaryHeaders({ Accept: 'application/epub+zip' });
  assert.equal(headers.get('accept-encoding'), 'identity');
  assert.equal(headers.get('accept'), 'application/epub+zip');

  const customEncoding = buildTauriBinaryHeaders({ 'Accept-Encoding': 'br' });
  assert.equal(customEncoding.get('accept-encoding'), 'br');
});

test('Web 与 Tauri 平台分支生成不同的安全请求配置', () => {
  assert.equal(resolveAppPlatform('tauri'), 'tauri');
  assert.equal(resolveAppPlatform('web'), 'web');
  assert.equal(resolveAppPlatform(undefined), 'web');

  const options = buildTauriRequestInit({ method: 'POST', credentials: 'include' });
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'include');
  assert.equal(options.maxRedirections, 5);
  assert.deepEqual(options.danger, {
    acceptInvalidCerts: true,
    acceptInvalidHostnames: true,
  });
});
