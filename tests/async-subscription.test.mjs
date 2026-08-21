import test from 'node:test';
import assert from 'node:assert/strict';

import { startAsyncSubscription } from '../src/lib/async-subscription.ts';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
