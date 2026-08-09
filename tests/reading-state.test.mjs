import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearReadStateCache,
  filterReadingStateBooks,
} from '../src/lib/reading-state.ts';

function okResponse(readState) {
  return new Response(JSON.stringify({ err: 'ok', read_state: readState }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('历史记录：已有 state.read_state 的书不发起网络请求', async () => {
  clearReadStateCache();
  const fetchLike = async () => {
    throw new Error('不应该发起网络请求');
  };
  const books = [
    { id: 1, state: { read_state: 1 } },
    { id: 2, state: { read_state: 2 } },
    { id: 3, state: { read_state: 0 } },
  ];
  const result = await filterReadingStateBooks(fetchLike, 'http://s', books);
  assert.deepEqual(result.reading.map((b) => b.id), [1]);
  assert.deepEqual(result.finished.map((b) => b.id), [2]);
});

test('历史记录：缺失 read_state 的书按 readstate 接口归类', async () => {
  clearReadStateCache();
  const calls = [];
  const fetchLike = async (url) => {
    calls.push(url);
    if (url.includes('/1/')) return okResponse(1);
    if (url.includes('/2/')) return okResponse(2);
    return okResponse(0);
  };
  const books = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = await filterReadingStateBooks(fetchLike, 'http://s', books);
  assert.deepEqual(result.reading.map((b) => b.id), [1]);
  assert.deepEqual(result.finished.map((b) => b.id), [2]);
  // 缺失 read_state 的三本书都会请求
  assert.equal(calls.length, 3);
});

test('历史记录：并发请求数受上限约束，不一次性全部发出', async () => {
  clearReadStateCache();
  let active = 0;
  let maxActive = 0;
  const fetchLike = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return okResponse(0);
  };
  const books = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
  const result = await filterReadingStateBooks(fetchLike, 'http://s', books);
  assert.ok(maxActive <= 6, `并发峰值 ${maxActive} 应 <= 6`);
  assert.equal(result.reading.length, 0);
  assert.equal(result.finished.length, 0);
});

test('历史记录：同一次会话内结果按 serverUrl+bookId 缓存', async () => {
  clearReadStateCache();
  const calls = [];
  const fetchLike = async (url) => {
    calls.push(url);
    return okResponse(url.includes('/1/') ? 1 : 2);
  };
  const books = [{ id: 1 }, { id: 2 }];

  const first = await filterReadingStateBooks(fetchLike, 'http://s', books);
  assert.equal(calls.length, 2);
  assert.deepEqual(first.reading.map((b) => b.id), [1]);

  const second = await filterReadingStateBooks(fetchLike, 'http://s', books);
  assert.equal(calls.length, 2, '缓存命中后不应再发请求');
  assert.deepEqual(second.reading.map((b) => b.id), [1]);
  assert.deepEqual(second.finished.map((b) => b.id), [2]);
});

test('历史记录：请求失败按未在读/未读完处理，不抛错', async () => {
  clearReadStateCache();
  const fetchLike = async () => {
    throw new Error('network down');
  };
  const books = [{ id: 1 }, { id: 2 }];
  const result = await filterReadingStateBooks(fetchLike, 'http://s', books);
  assert.equal(result.reading.length, 0);
  assert.equal(result.finished.length, 0);
});
