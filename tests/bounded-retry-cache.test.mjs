import test from 'node:test';
import assert from 'node:assert/strict';

import { createBoundedRetryCache } from '../src/lib/bounded-retry-cache.ts';

test('失败的平台探测会有界重试，并缓存首次成功结果', async () => {
  let attempts = 0;
  const delays = [];
  const cache = createBoundedRetryCache(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('IPC not ready');
      return 'android';
    },
    {
      maxAttempts: 3,
      retryDelayMs: 250,
      sleep: async (delayMs) => delays.push(delayMs),
    },
  );

  assert.equal(await cache.get(), 'android');
  assert.equal(await cache.get(), 'android');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
});

test('并发调用共享同一组探测重试', async () => {
  let attempts = 0;
  let releaseAttempt;
  const pendingAttempt = new Promise((resolve) => {
    releaseAttempt = resolve;
  });
  const cache = createBoundedRetryCache(
    async () => {
      attempts += 1;
      await pendingAttempt;
      return 'ios';
    },
    { maxAttempts: 3, retryDelayMs: 0 },
  );

  const first = cache.get();
  const second = cache.get();
  assert.equal(first, second);
  assert.equal(attempts, 1);

  releaseAttempt();
  assert.deepEqual(await Promise.all([first, second]), ['ios', 'ios']);
  assert.equal(attempts, 1);
});

test('持续失败达到上限后不会由后续调用形成请求风暴', async () => {
  let attempts = 0;
  const cache = createBoundedRetryCache(
    async () => {
      attempts += 1;
      throw new Error(`failure ${attempts}`);
    },
    {
      maxAttempts: 3,
      retryDelayMs: 0,
      sleep: async () => {},
    },
  );

  await assert.rejects(cache.get(), /failure 3/);
  await assert.rejects(cache.get(), /failure 3/);
  assert.equal(attempts, 3);
});
