import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openAndRecordBookRead,
  recordAndOpenBookRead,
  recordBookRead,
} from '../src/lib/book-read.ts';

test('阅读器成功打开后通过 Talebook 阅读路由持久化一次记录', async () => {
  const events = [];
  const requests = [];

  await openAndRecordBookRead({
    open: async () => events.push('opened'),
    record: () => recordBookRead(async (url, init) => {
      events.push('recorded');
      requests.push({ url, init });
      return new Response('', { status: 200 });
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
  const fake = {
    ok: true,
    status: 200,
    url: 'https://books.example/login',
    arrayBuffer: async () => new ArrayBuffer(0),
  };

  await assert.rejects(
    recordBookRead(async () => fake, 'https://books.example', 'a'),
    /book\.read_record\.redirect/,
  );
});

test('仍落在阅读路由上的重定向视为记录成功', async () => {
  const fake = {
    ok: true,
    status: 200,
    url: 'https://books.example/read/a/',
    arrayBuffer: async () => new ArrayBuffer(0),
  };

  await recordBookRead(async () => fake, 'https://books.example', 'a');
});

test('记录请求会排空响应体以尽早释放连接', async () => {
  let drained = false;

  await recordBookRead(async () => ({
    ok: true,
    status: 200,
    url: 'https://books.example/read/1',
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
    return new Response('', { status: 200 });
  }, 'https://books.example', 'a', 1);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, false);
  assert.equal(lateAbortCalls, 0);
});

test('记录请求超时后仍会中止未完成的请求', async () => {
  await assert.rejects(
    recordBookRead(async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    }), 'https://books.example', 'a', 1),
    (error) => error instanceof DOMException && error.name === 'AbortError',
  );
});
