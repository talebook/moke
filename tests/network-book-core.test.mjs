import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNetworkBookHref,
  flattenNetworkSearchResults,
  pollNetworkSave,
  pollNetworkSearch,
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

test('flattenNetworkSearchResults 保留分组的 source_id/source_name', () => {
  const books = flattenNetworkSearchResults([
    {
      source_id: 1,
      source_name: '源A',
      books: [{ title: '书A', book_url: 'u1' }],
    },
    {
      source_id: 2,
      source_name: '源B',
      items: [{ title: '书B', book_url: 'u2' }],
    },
  ]);
  assert.deepEqual(books, [
    { title: '书A', book_url: 'u1', source_id: 1, source_name: '源A' },
    { title: '书B', book_url: 'u2', source_id: 2, source_name: '源B' },
  ]);
});

test('flattenNetworkSearchResults 单本自带的 source_id 优先于分组', () => {
  const books = flattenNetworkSearchResults([
    {
      source_id: 1,
      source_name: '源A',
      books: [{ title: '书A', book_url: 'u1', source_id: 9, source_name: '源X' }],
    },
  ]);
  assert.deepEqual(books, [{ title: '书A', book_url: 'u1', source_id: 9, source_name: '源X' }]);
});

test('flattenNetworkSearchResults 空/散装条目安全返回空数组', () => {
  assert.deepEqual(flattenNetworkSearchResults(undefined), []);
  assert.deepEqual(flattenNetworkSearchResults([]), []);
  assert.deepEqual(flattenNetworkSearchResults([{}, null, 'x']), []);
});

test('pollNetworkSearch 直到 finished 才返回，中间结果通过 onPartial 上报', async () => {
  const partials = [];
  const responses = [
    { results: [{ source_id: 1, books: [{ title: 'A', book_url: 'u' }] }], finished: false },
    { results: [{ source_id: 2, books: [{ title: 'B', book_url: 'v' }] }], finished: true },
  ];
  const result = await pollNetworkSearch({
    fetchStatus: async () => responses.shift() ?? null,
    sleep: noopSleep,
    onPartial: (books) => partials.push(books),
  });
  assert.equal(result?.finished, true);
  assert.equal(partials.length, 2);
  assert.equal(partials[0][0].title, 'A');
  assert.equal(partials[1][0].title, 'B');
});

test('pollNetworkSearch 达到 maxAttempts 未完成时返回 null', async () => {
  const { calls, sleep } = makeFakeSleep();
  const result = await pollNetworkSearch({
    fetchStatus: async () => ({ results: [], finished: false }),
    sleep,
    maxAttempts: 3,
  });
  assert.equal(result, null);
  assert.equal(calls(), 3);
});

test('pollNetworkSearch 已中止的 signal 立即返回 null', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;
  const result = await pollNetworkSearch({
    fetchStatus: async () => {
      fetches++;
      return { results: [], finished: false };
    },
    signal: controller.signal,
    sleep: noopSleep,
  });
  assert.equal(result, null);
  assert.equal(fetches, 0);
});

test('pollNetworkSearch 轮询途中 abort 后不再回写 onPartial', async () => {
  const controller = new AbortController();
  const partials = [];
  let fetches = 0;
  let sleeps = 0;
  const result = await pollNetworkSearch({
    fetchStatus: async () => {
      fetches++;
      if (fetches === 1) {
        return { results: [{ source_id: 1, books: [{ title: 'A', book_url: 'u' }] }], finished: false };
      }
      return { results: [{ source_id: 2, books: [{ title: 'B', book_url: 'v' }] }], finished: true };
    },
    signal: controller.signal,
    sleep: async () => {
      sleeps++;
      if (sleeps === 2) controller.abort();
    },
    onPartial: (books) => partials.push(books),
  });
  // 第一次轮询已回写 partial A；第二次 sleep 中 abort → 立即返回 null，不再发起第二次轮询。
  assert.equal(result, null);
  assert.equal(fetches, 1);
  assert.equal(sleeps, 2);
  assert.equal(partials.length, 1);
  assert.equal(partials[0][0].title, 'A');
});

test('pollNetworkSearch 轮询错误向上传播，不吞异常', async () => {
  await assert.rejects(
    () => pollNetworkSearch({
      fetchStatus: async () => {
        throw new Error('network down');
      },
      sleep: noopSleep,
      maxAttempts: 2,
    }),
    (error) => error instanceof Error && error.message === 'network down',
  );
});
