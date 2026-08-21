import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openAndRecordBookRead,
  recordAndOpenBookRead,
  recordBookRead,
} from '../src/lib/book-read.ts';

function fakeResponse({
  body = '',
  contentType = 'text/html; charset=utf-8',
  status = 200,
  url = 'https://books.example/read/a',
} = {}) {
  const encoded = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => encoded.buffer,
  };
}

test('阅读器成功打开后通过 Talebook 阅读路由持久化一次记录', async () => {
  const events = [];
  const requests = [];

  await openAndRecordBookRead({
    open: async () => events.push('opened'),
    record: () => recordBookRead(async (url, init) => {
      events.push('recorded');
      requests.push({ url, init });
      return fakeResponse({ url: 'https://books.example/read/a%2Fb' });
    }, 'https://books.example', 'a/b'),
  });

  assert.deepEqual(events, ['opened', 'recorded']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://books.example/read/a%2Fb');
  assert.equal(requests[0].init.credentials, 'include');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('阅读器打开失败时不增加阅读记录', async () => {
  let recordCalls = 0;

  await assert.rejects(
    openAndRecordBookRead({
      open: async () => { throw new Error('window failed'); },
      record: async () => { recordCalls += 1; },
    }),
    /window failed/,
  );
  assert.equal(recordCalls, 0);
});

test('记录同步失败不把已经成功的打开操作误报为失败', async () => {
  const errors = [];

  await openAndRecordBookRead({
    open: async () => {},
    record: async () => { throw new Error('network failed'); },
    onRecordError: (error) => errors.push(error),
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /network failed/);
});

test('桌面阅读器打开后立即释放 UI 状态再同步记录', async () => {
  const events = [];

  await openAndRecordBookRead({
    open: async () => events.push('opened'),
    onOpened: () => events.push('unlocked'),
    record: async () => events.push('recorded'),
  });

  assert.deepEqual(events, ['opened', 'unlocked', 'recorded']);
});

test('单 WebView 在导航前记录，记录失败仍继续打开阅读器', async () => {
  const events = [];
  const errors = [];

  await recordAndOpenBookRead({
    record: async () => {
      events.push('recorded');
      throw new Error('network failed');
    },
    open: async () => events.push('opened'),
    onRecordError: (error) => errors.push(error),
  });

  assert.deepEqual(events, ['recorded', 'opened']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /network failed/);
});

test('会话失效被重定向到登录页时不误报记录成功', async () => {
  await assert.rejects(
    recordBookRead(async () => fakeResponse({ url: 'https://books.example/login' }), 'https://books.example', 'a'),
    /book\.read_record\.redirect/,
  );
});

test('会话失效被重定向到站点根路径时不误报记录成功', async () => {
  await assert.rejects(
    recordBookRead(async () => fakeResponse({ url: 'https://books.example/' }), 'https://books.example', 'a'),
    /book\.read_record\.redirect/,
  );
});

test('重定向到其他来源的同名阅读路径时不误报记录成功', async () => {
  await assert.rejects(
    recordBookRead(async () => fakeResponse({ url: 'https://login.example/read/a' }), 'https://books.example', 'a'),
    /book\.read_record\.redirect/,
  );
});

test('仍落在同源阅读路由上的重定向视为记录成功', async () => {
  await recordBookRead(
    async () => fakeResponse({ url: 'https://books.example/read/a/' }),
    'https://books.example',
    'a',
  );
});

test('JSON 成功响应遵循明确的 err=ok 契约', async () => {
  await recordBookRead(
    async () => fakeResponse({ body: JSON.stringify({ err: 'ok' }), contentType: 'application/json' }),
    'https://books.example',
    'a',
  );
});

test('HTTP 200 的 JSON API 错误不会误报记录成功', async () => {
  await assert.rejects(
    recordBookRead(
      async () => fakeResponse({ body: JSON.stringify({ err: 'user.need_login' }), contentType: 'application/json' }),
      'https://books.example',
      'a',
    ),
    /book\.read_record\.api\.user\.need_login/,
  );
});

test('非成功 HTTP 状态返回记录错误', async () => {
  await assert.rejects(
    recordBookRead(async () => fakeResponse({ status: 403 }), 'https://books.example', 'a'),
    /book\.read_record\.http\.403/,
  );
});

test('记录请求会排空响应体以尽早释放连接', async () => {
  let drained = false;

  await recordBookRead(async () => ({
    ...fakeResponse({ url: 'https://books.example/read/1' }),
    arrayBuffer: async () => {
      drained = true;
      return new ArrayBuffer(0);
    },
  }), 'https://books.example', '1');

  assert.equal(drained, true);
});

test('WebView 缺少 AbortSignal.timeout 时仍会携带超时信号', async () => {
  const original = AbortSignal.timeout;
  delete AbortSignal.timeout;
  try {
    let capturedSignal;
    await recordBookRead(async (url, init) => {
      capturedSignal = init.signal;
      return fakeResponse();
    }, 'https://books.example', 'a', 100);

    assert.ok(capturedSignal instanceof AbortSignal);
  } finally {
    AbortSignal.timeout = original;
  }
});

test('请求提前完成后清除超时定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let capturedSignal;

  await recordBookRead(async (url, init) => {
    capturedSignal = init.signal;
    return fakeResponse();
  }, 'https://books.example', 'a', 100);

  t.mock.timers.tick(100);
  assert.equal(capturedSignal.aborted, false);
});

test('记录请求超过整体时限后释放调用方', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = recordBookRead(
    async () => new Promise(() => {}),
    'https://books.example',
    'a',
    100,
  );

  t.mock.timers.tick(100);
  await assert.rejects(pending, /book\.read_record\.timeout/);
});
