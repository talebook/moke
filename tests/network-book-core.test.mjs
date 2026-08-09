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

test('pollNetworkSave completed 但缺 book_id 时仍返回 completed（不误判丢失）', async () => {
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'completed' }),
    sleep: noopSleep,
  });
  assert.deepEqual(state, { status: 'completed', bookId: undefined });
});

test('pollNetworkSave 未知 status（pending/queued）按 miss 计数，不直接判 failed', async () => {
  const { calls, sleep } = makeFakeSleep();
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'pending' }),
    intervalMs: 100,
    maxMisses: 3,
    sleep,
  });
  assert.equal(calls(), 2); // pending#1 与 pending#2 后各等待一次，pending#3 直接判 lost
  assert.deepEqual(state, { status: 'lost' });
});

test('pollNetworkSave 未知 status 后恢复 running/completed 不误判', async () => {
  const responses = [
    { found: true, status: 'pending' },
    { found: true, status: 'running', progress: 20, done: 1, total: 5 },
    { found: true, status: 'completed', book_id: 11 },
  ];
  const state = await pollNetworkSave({
    fetchStatus: async () => responses.shift() ?? { found: false },
    sleep: noopSleep,
    maxMisses: 3,
  });
  assert.deepEqual(state, { status: 'completed', bookId: 11 });
});

test('pollNetworkSave 超过总时长上限返回 timeout', async () => {
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'running', progress: 10, done: 1, total: 10 }),
    sleep: noopSleep,
    timeoutMs: 0, // 立即超时
  });
  assert.deepEqual(state, { status: 'timeout' });
});

test('pollNetworkSave 收到 AbortSignal 后返回 aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'running', progress: 10, done: 1, total: 10 }),
    sleep: noopSleep,
    signal: controller.signal,
  });
  assert.deepEqual(state, { status: 'aborted' });
});

test('pollNetworkSave 轮询途中取消返回 aborted，不再继续请求', async () => {
  const controller = new AbortController();
  let requests = 0;
  const state = await pollNetworkSave({
    fetchStatus: async () => {
      requests += 1;
      if (requests >= 2) controller.abort();
      return { found: true, status: 'running', progress: 10, done: 1, total: 10 };
    },
    sleep: noopSleep,
    signal: controller.signal,
  });
  assert.equal(requests, 2);
  assert.deepEqual(state, { status: 'aborted' });
});

test('pollNetworkSave 超时上限后未知状态也返回 timeout（防无限轮询）', async () => {
  const state = await pollNetworkSave({
    fetchStatus: async () => ({ found: true, status: 'pending' }),
    sleep: noopSleep,
    timeoutMs: 0,
    maxMisses: 100,
  });
  assert.deepEqual(state, { status: 'timeout' });
});
