import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNetworkBookHref,
  pollNetworkSave,
} from '../src/lib/network-book-core.ts';

function noopSleep() {
  return Promise.resolve();
}

/** 收集 sleep 调用次数（代替真实等待）。 */
function makeFakeSleep() {
  let calls = 0;
  return {
    calls: () => calls,
    sleep: () => {
      calls += 1;
      return Promise.resolve();
    },
  };
}

test('buildNetworkBookHref 携带 source_id 并编码 book_url', () => {
  const href = buildNetworkBookHref(12, 'https://example.com/book?a=1&b=中文');
  const url = new URL(href, 'https://moke.invalid');
  assert.equal(url.pathname, '/network-book');
  assert.equal(url.searchParams.get('source_id'), '12');
  assert.equal(url.searchParams.get('book_url'), 'https://example.com/book?a=1&b=中文');
});

test('pollNetworkSave 任务已完成时直接返回 completed 和 book_id', async () => {
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'completed', book_id: 42 }),
    sleep: noopSleep,
  });
  assert.deepEqual(state, { status: 'completed', bookId: 42 });
});

test('pollNetworkSave running 后进入 completed，并回报进度', async () => {
  const updates = [];
  const responses = [
    { found: true, status: 'running', progress: 40, done: 2, total: 5 },
    { found: true, status: 'completed', book_id: 7 },
  ];
  const state = await pollNetworkSave({
    fetchStatus: async () => responses.shift() ?? { found: false },
    sleep: noopSleep,
    onUpdate: (s) => updates.push(s),
  });
  assert.deepEqual(updates, [
    { status: 'running', progress: 40, done: 2, total: 5 },
    { status: 'completed', bookId: 7 },
  ]);
  assert.deepEqual(state, { status: 'completed', bookId: 7 });
});

test('pollNetworkSave failed 时返回错误信息', async () => {
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'failed', error: '超时' }),
    sleep: noopSleep,
  });
  assert.deepEqual(state, { status: 'failed', error: '超时' });
});

test('pollNetworkSave 连续 maxMisses 次查不到任务判定 lost', async () => {
  const { calls, sleep } = makeFakeSleep();
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: false }),
    intervalMs: 100,
    maxMisses: 3,
    sleep,
  });
  assert.equal(calls(), 2); // miss#1 与 miss#2 后各等待一次，miss#3 直接返回
  assert.deepEqual(state, { status: 'lost' });
});

test('pollNetworkSave 单次瞬时 miss 后恢复不会误判 lost', async () => {
  const responses = [
    { found: false }, // 瞬时 miss
    { found: true, status: 'running', progress: 10, done: 1, total: 10 },
    { found: true, status: 'completed', book_id: 3 },
  ];
  const state = await pollNetworkSave({
    fetchStatus: async () => responses.shift() ?? { found: false },
    sleep: noopSleep,
    maxMisses: 3,
  });
  assert.deepEqual(state, { status: 'completed', bookId: 3 });
});

test('pollNetworkSave 连续 fetchStatus 异常按 miss 计，直接判 lost', async () => {
  const { sleep } = makeFakeSleep();
  const state = await pollNetworkSave({
    fetchStatus: async () => {
      throw new Error('network down');
    },
    sleep,
    maxMisses: 2,
  });
  assert.deepEqual(state, { status: 'lost' });
});

test('pollNetworkSave 异常后恢复：先抛错再完成，不误判 lost', async () => {
  const responses = [
    new Error('network down'),
    { found: true, status: 'running', progress: 0, done: 0, total: 2 },
    { found: true, status: 'completed', book_id: 9 },
  ];
  const state = await pollNetworkSave({
    fetchStatus: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? { found: false };
    },
    sleep: noopSleep,
    maxMisses: 3,
  });
  assert.deepEqual(state, { status: 'completed', bookId: 9 });
});
