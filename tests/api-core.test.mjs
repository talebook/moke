import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MokeApiError,
  buildTauriRequestInit,
  getErrorMessage,
  isAbsoluteHttpUrl,
  readApiJson,
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
