import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFLINE_BOOK_STALE_CONCURRENCY,
  OFFLINE_BOOK_STALE_DEBOUNCE_MS,
  OfflineBookStaleCheckScheduler,
  checkOfflineBookFreshness,
  checkOfflineBooksFreshness,
} from '../src/lib/offline-book-stale.ts';

function headResponse(headers = {}, ok = true) {
  return {
    ok,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

function record(overrides = {}) {
  return {
    id: 'https://books.test::1::epub',
    serverUrl: 'https://books.test',
    bookId: '1',
    format: 'epub',
    sourceSignature: 'etag-v1',
    ...overrides,
  };
}

test('缺少本地或远端签名时不会错误确认新鲜', async () => {
  let headCalls = 0;
  const requestHead = async () => {
    headCalls += 1;
    return headResponse();
  };

  const missingLocal = await checkOfflineBookFreshness(
    'https://books.test',
    record({ id: 'missing-local', sourceSignature: undefined }),
    requestHead,
  );
  assert.equal(missingLocal.status, 'unknown');
  assert.equal(headCalls, 0, '没有可比较的本地签名时不应发 HEAD');

  const wrongServer = await checkOfflineBookFreshness(
    'https://other.test',
    record({ id: 'wrong-server' }),
    requestHead,
  );
  assert.equal(wrongServer.status, 'unknown');
  assert.equal(headCalls, 0, '切换服务器期间不应拿旧记录发 HEAD');

  const missingRemote = await checkOfflineBookFreshness(
    'https://books.test',
    record({ id: 'missing-remote' }),
    requestHead,
  );
  assert.equal(missingRemote.status, 'unknown');
  assert.equal(headCalls, 1);
});

test('签名差异、匹配和离线状态会被明确区分', async () => {
  const matching = await checkOfflineBookFreshness(
    'https://books.test/',
    record({ id: 'matching' }),
    async (url) => {
      assert.equal(url, 'https://books.test/api/book/1.epub');
      return headResponse({ etag: 'etag-v1' });
    },
  );
  assert.equal(matching.status, 'fresh');

  const stale = await checkOfflineBookFreshness(
    'https://books.test',
    record({ id: 'stale' }),
    async () => headResponse({ 'last-modified': 'etag-v2' }),
  );
  assert.equal(stale.status, 'stale');

  const offline = await checkOfflineBookFreshness(
    'https://books.test',
    record({ id: 'offline' }),
    async () => { throw new Error('offline'); },
  );
  assert.equal(offline.status, 'unavailable');
});

test('相同记录的并发 stale 检测复用同一个 HEAD', async () => {
  let resolveHead;
  let headCalls = 0;
  const pendingHead = new Promise((resolve) => { resolveHead = resolve; });
  const requestHead = () => {
    headCalls += 1;
    return pendingHead;
  };
  const target = record({ id: 'deduplicated' });

  const first = checkOfflineBookFreshness('https://books.test', target, requestHead);
  const second = checkOfflineBookFreshness('https://books.test', target, requestHead);
  assert.equal(headCalls, 1);

  resolveHead(headResponse({ etag: 'etag-v1' }));
  assert.deepEqual(await first, { status: 'fresh', remoteSignature: 'etag-v1' });
  assert.deepEqual(await second, { status: 'fresh', remoteSignature: 'etag-v1' });
});

test('频繁记录/终态变化只触发一轮去抖 HEAD 检测', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let headCalls = 0;
  const scheduler = new OfflineBookStaleCheckScheduler(async () => {
    headCalls += 1;
    return headResponse({ etag: 'etag-v1' });
  });
  const records = [
    record({ id: 'signed-1', bookId: '1' }),
    record({ id: 'signed-2', bookId: '2' }),
    record({ id: 'unsigned', bookId: '3', sourceSignature: undefined }),
  ];
  const results = [];

  for (let update = 0; update < 100; update += 1) {
    scheduler.schedule('https://books.test', records, (value) => results.push(value));
  }
  t.mock.timers.tick(OFFLINE_BOOK_STALE_DEBOUNCE_MS - 1);
  assert.equal(headCalls, 0);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(headCalls, 2, '一轮检测最多为每条有签名记录发送一个 HEAD');
  assert.equal(results.length, 1);
  assert.equal(results[0].get('unsigned')?.status, 'unknown');
  scheduler.cancel();
  t.mock.timers.reset();
});

test('批量 stale 检测限制 HEAD 并发数', async () => {
  let active = 0;
  let maximum = 0;
  const records = Array.from({ length: 20 }, (_, index) => record({
    id: `book-${index}`,
    bookId: String(index),
  }));
  const results = await checkOfflineBooksFreshness('https://books.test', records, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return headResponse({ etag: 'etag-v1' });
  });

  assert.equal(results.size, records.length);
  assert.ok(maximum <= OFFLINE_BOOK_STALE_CONCURRENCY);
  assert.equal(maximum, OFFLINE_BOOK_STALE_CONCURRENCY);
});
