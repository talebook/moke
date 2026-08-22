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

test('响应未暴露最终 URL 时不会绕过重定向验证', async () => {
  await assert.rejects(
    recordBookRead(
      async () => fakeResponse({ url: '' }),
      'https://books.example',
      'a',
    ),
    /book\.read_record\.redirect/,
  );
});

test('同主机默认端口允许从 HTTP 安全升级到 HTTPS', async () => {
  await recordBookRead(
    async () => fakeResponse({ url: 'https://books.example/read/a' }),
    'http://books.example',
    'a',
  );
});

test('阅读记录重定向拒绝协议降级和非默认端口变化', async () => {
  await assert.rejects(
    recordBookRead(
      async () => fakeResponse({ url: 'http://books.example/read/a' }),
      'https://books.example',
      'a',
    ),
    /book\.read_record\.redirect/,
  );
  await assert.rejects(
    recordBookRead(
      async () => fakeResponse({ url: 'https://books.example:8443/read/a' }),
      'https://books.example',
      'a',
    ),
    /book\.read_record\.redirect/,
  );
});

test('重定向 URL 解码后的书籍路径仍可与编码请求匹配', async () => {
  await recordBookRead(
    async () => fakeResponse({ url: 'https://books.example/read/a/b' }),
    'https://books.example',
    'a/b',
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

test('服务端错误码只允许有限长度的安全字符', async () => {
  await assert.rejects(
    recordBookRead(
      async () => fakeResponse({
        body: JSON.stringify({ err: 'user.need_login\nforged-log' }),
        contentType: 'application/json',
      }),
      'https://books.example',
      'a',
    ),
    /book\.read_record\.api\.invalid/,
  );
  await assert.rejects(
    recordBookRead(
      async () => fakeResponse({
        body: JSON.stringify({ err: 'a'.repeat(65) }),
        contentType: 'application/json',
      }),
      'https://books.example',
      'a',
    ),
    /book\.read_record\.api\.invalid/,
  );
});

test('非成功 HTTP 状态返回记录错误', async () => {
  await assert.rejects(
    recordBookRead(async () => fakeResponse({ status: 403 }), 'https://books.example', 'a'),
    /book\.read_record\.http\.403/,
  );
});

test('非成功 JSON 响应读体失败时保留 HTTP 状态错误', async () => {
  await assert.rejects(
    recordBookRead(async () => ({
      ...fakeResponse({ contentType: 'application/json', status: 503 }),
      arrayBuffer: async () => { throw new Error('body read failed'); },
    }), 'https://books.example', 'a'),
    /book\.read_record\.http\.503/,
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

test('记录完成后取消超时，避免晚到 abort 操作已释放的 Tauri resource', async () => {
  let capturedSignal;
  let lateAbortCalls = 0;

  await recordBookRead(async (url, init) => {
    capturedSignal = init.signal;
    capturedSignal.addEventListener('abort', () => { lateAbortCalls += 1; });
    return fakeResponse();
  }, 'https://books.example', 'a', 1);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, false);
  assert.equal(lateAbortCalls, 0);
});

test('记录请求失败后也取消超时，避免晚到 abort', async () => {
  let capturedSignal;
  let lateAbortCalls = 0;

  await assert.rejects(
    recordBookRead(async (url, init) => {
      capturedSignal = init.signal;
      capturedSignal.addEventListener('abort', () => { lateAbortCalls += 1; });
      throw new Error('network failed');
    }, 'https://books.example', 'a', 1),
    /network failed/,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, false);
  assert.equal(lateAbortCalls, 0);
});

test('记录请求超时后仍会中止未完成的请求', async () => {
  let capturedSignal;
  await assert.rejects(
    recordBookRead(async (url, init) => new Promise((resolve, reject) => {
      capturedSignal = init.signal;
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    }), 'https://books.example', 'a', 1),
    /book\.read_record\.timeout/,
  );
  assert.equal(capturedSignal.aborted, true);
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

test('HTML 响应排空超时不会把已持久化记录误报为失败', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted;
  const bodyStartedPromise = new Promise((resolve) => { bodyStarted = resolve; });
  let capturedSignal;

  const pending = recordBookRead(async (url, init) => ({
    ...fakeResponse(),
    arrayBuffer: async () => {
      capturedSignal = init.signal;
      bodyStarted();
      return new Promise(() => {});
    },
  }), 'https://books.example', 'a', 100);

  await bodyStartedPromise;
  t.mock.timers.tick(100);
  await pending;
  assert.equal(capturedSignal.aborted, true);
});

test('JSON 响应体读取超时仍作为无法验证的记录失败', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted;
  const bodyStartedPromise = new Promise((resolve) => { bodyStarted = resolve; });

  const pending = recordBookRead(async () => ({
    ...fakeResponse({ contentType: 'application/json' }),
    arrayBuffer: async () => {
      bodyStarted();
      return new Promise(() => {});
    },
  }), 'https://books.example', 'a', 100);

  await bodyStartedPromise;
  t.mock.timers.tick(100);
  await assert.rejects(pending, /book\.read_record\.timeout/);
});
