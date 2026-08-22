import test from 'node:test';
import assert from 'node:assert/strict';

import { startAsyncSubscription } from '../src/lib/async-subscription.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test('异步订阅：import 完成前清理，晚到的监听会立即释放', async () => {
  const imported = deferred();
  let listenCalls = 0;
  let unlistenCalls = 0;

  const cancel = startAsyncSubscription(async () => {
    const { listen } = await imported.promise;
    return listen();
  }, assert.fail);

  cancel();
  assert.equal(listenCalls, 0);

  imported.resolve({
    listen: async () => {
      listenCalls += 1;
      return () => { unlistenCalls += 1; };
    },
  });
  await flushPromises();

  assert.equal(listenCalls, 1);
  assert.equal(unlistenCalls, 1);
});

test('异步订阅：listen 完成前清理，注册完成后立即释放', async () => {
  const listening = deferred();
  let listenCalls = 0;
  let unlistenCalls = 0;

  const cancel = startAsyncSubscription(async () => {
    listenCalls += 1;
    return listening.promise;
  }, assert.fail);

  assert.equal(listenCalls, 1);
  cancel();
  listening.resolve(() => { unlistenCalls += 1; });
  await flushPromises();

  assert.equal(unlistenCalls, 1);
});

test('异步订阅：listen 完成后清理会释放现有监听', async () => {
  let unlistenCalls = 0;
  const cancel = startAsyncSubscription(
    async () => () => { unlistenCalls += 1; },
    assert.fail,
  );

  await flushPromises();
  cancel();

  assert.equal(unlistenCalls, 1);
});

test('异步订阅：依赖快速变化后只保留一个有效监听', async () => {
  const firstListening = deferred();
  const listeners = new Set();
  let saves = 0;

  const listen = async (gate) => {
    if (gate) await gate.promise;
    const listener = () => { saves += 1; };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  const cancelFirst = startAsyncSubscription(() => listen(firstListening), assert.fail);
  cancelFirst();
  const cancelSecond = startAsyncSubscription(() => listen(), assert.fail);
  await flushPromises();

  firstListening.resolve();
  await flushPromises();

  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener();
  assert.equal(saves, 1);

  cancelSecond();
  assert.equal(listeners.size, 0);
});

test('异步订阅：取消后迟到的失败不会上报', async () => {
  const subscription = deferred();
  const reportedErrors = [];
  const cancel = startAsyncSubscription(
    () => subscription.promise,
    (error) => { reportedErrors.push(error); },
  );

  cancel();
  subscription.reject(new Error('late subscription failure'));
  await flushPromises();

  assert.deepEqual(reportedErrors, []);
});

test('异步订阅：未取消时订阅失败恰好上报一次', async () => {
  const subscription = deferred();
  const expectedError = new Error('subscription failure');
  const reportedErrors = [];
  startAsyncSubscription(
    () => subscription.promise,
    (error) => { reportedErrors.push(error); },
  );

  subscription.reject(expectedError);
  await flushPromises();

  assert.deepEqual(reportedErrors, [expectedError]);
});

test('异步订阅：cancel 重复调用只清理一次', async () => {
  let cleanupCalls = 0;
  const cancel = startAsyncSubscription(
    async () => () => { cleanupCalls += 1; },
    assert.fail,
  );

  await flushPromises();
  cancel();
  cancel();

  assert.equal(cleanupCalls, 1);
});

test('异步订阅：取消后晚到的 cleanup 抛错不会误报', async () => {
  const subscription = deferred();
  const reportedErrors = [];
  let cleanupCalls = 0;
  const cancel = startAsyncSubscription(
    () => subscription.promise,
    (error) => { reportedErrors.push(error); },
  );

  cancel();
  subscription.resolve(() => {
    cleanupCalls += 1;
    throw new Error('cleanup failure');
  });
  await flushPromises();

  assert.equal(cleanupCalls, 1);
  assert.deepEqual(reportedErrors, []);
});
