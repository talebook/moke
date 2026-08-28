import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NATIVE_BACK_TRANSITION_TIMEOUT_MS,
  NativeBackTransitionController,
  shouldAnimateNativeBack,
} from '../src/lib/native-back-transition.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function createHarness(startViewTransition, initialPathname = '/shelf') {
  const navigations = [];
  const activeStates = [];
  const timers = new Map();
  let nextTimerId = 1;
  const controller = new NativeBackTransitionController(initialPathname, {
    navigate: (target) => navigations.push(target),
    canAnimate: () => true,
    startViewTransition,
    setTransitionActive: (active) => activeStates.push(active),
    setTimeout: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return { controller, navigations, activeStates, timers };
}

function normalTransition() {
  const finished = deferred();
  const updateDone = deferred();
  let updatePromise;
  let skipped = 0;
  return {
    finished,
    updateDone,
    get updatePromise() { return updatePromise; },
    get skipped() { return skipped; },
    start(update) {
      updatePromise = update();
      void updatePromise.then(updateDone.resolve, updateDone.reject);
      return {
        finished: finished.promise,
        updateCallbackDone: updateDone.promise,
        skipTransition: () => { skipped += 1; },
      };
    },
  };
}

test('返回动画在移动端使用 View Transition、桌面端使用内容动画', () => {
  assert.equal(shouldAnimateNativeBack('android', false, true), true);
  assert.equal(shouldAnimateNativeBack('ios', false, true), true);
  assert.equal(shouldAnimateNativeBack('ohos', false, true), true);
  assert.equal(shouldAnimateNativeBack('windows', false, true), true);
  assert.equal(shouldAnimateNativeBack('macos', false, true), true);
  assert.equal(shouldAnimateNativeBack('linux', false, true), true);
  assert.equal(shouldAnimateNativeBack('desktop', false, true), true);
  assert.equal(shouldAnimateNativeBack('web', false, true), false);
  assert.equal(shouldAnimateNativeBack('android', true, true), false);
  assert.equal(shouldAnimateNativeBack('android', false, false), false);
});

test('快速两次 BACK 排队退两级，不吞掉第二次事件', async () => {
  const first = normalTransition();
  const second = normalTransition();
  const transitions = [first, second];
  const harness = createHarness((update) => transitions.shift().start(update));
  harness.controller.pathnameChanged('/library');
  harness.controller.pathnameChanged('/detail');

  harness.controller.requestBack();
  harness.controller.requestBack();
  assert.deepEqual(harness.navigations, ['/library']);

  harness.controller.pathnameChanged('/library');
  first.finished.resolve();
  await flushPromises();

  assert.deepEqual(harness.navigations, ['/library', '/shelf']);
});

test('动画期间手动导航会取消排队 BACK 并重建规划状态', async () => {
  const first = normalTransition();
  const afterManualNavigation = normalTransition();
  const transitions = [first, afterManualNavigation];
  const harness = createHarness((update) => transitions.shift().start(update));
  harness.controller.pathnameChanged('/library');
  harness.controller.pathnameChanged('/detail');

  harness.controller.requestBack();
  harness.controller.requestBack();
  assert.deepEqual(harness.navigations, ['/library']);

  harness.controller.pathnameChanged('/settings');
  assert.equal(first.skipped, 1);
  first.finished.resolve();
  await flushPromises();
  assert.deepEqual(harness.navigations, ['/library']);

  harness.controller.requestBack();
  assert.deepEqual(harness.navigations, ['/library', '/shelf']);
});

test('返回目标提交后立即重进原页面，第二次返回不会被旧动画锁吞掉', async () => {
  const first = normalTransition();
  const second = normalTransition();
  const transitions = [first, second];
  const harness = createHarness((update) => transitions.shift().start(update), '/shelf');
  harness.controller.pathnameChanged('/detail');

  harness.controller.requestBack();
  assert.deepEqual(harness.navigations, ['/shelf']);

  // Parent commits, but the first visual transition has not finished yet.
  harness.controller.pathnameChanged('/shelf');
  harness.controller.pathnameChanged('/detail');
  assert.equal(first.skipped, 1);

  harness.controller.requestBack();
  assert.deepEqual(harness.navigations, ['/shelf', '/shelf']);

  harness.controller.pathnameChanged('/shelf');
  second.finished.resolve();
  await flushPromises();
  assert.deepEqual(harness.navigations, ['/shelf', '/shelf']);
});

test('startViewTransition 同步抛错后回退导航并释放锁', () => {
  const harness = createHarness(() => {
    throw new DOMException('busy', 'InvalidStateError');
  }, '/detail');

  harness.controller.requestBack();
  harness.controller.requestBack();

  assert.deepEqual(harness.navigations, ['/library', '/shelf']);
  assert.deepEqual(harness.activeStates, [true, false, true, false]);
});

test('被 skip 且未执行 update callback 时仍执行返回并可继续处理', async () => {
  const harness = createHarness(() => ({
    finished: Promise.reject(new Error('skipped')),
    updateCallbackDone: Promise.reject(new Error('skipped')),
    skipTransition: () => undefined,
  }), '/detail');

  harness.controller.requestBack();
  assert.deepEqual(harness.navigations, ['/library']);
  await flushPromises();
  harness.controller.requestBack();
  await flushPromises();

  assert.deepEqual(harness.navigations, ['/library', '/shelf']);
  assert.equal(harness.activeStates.at(-1), false);
});

test('慢路由超时会 skip 动画而非捕获陈旧快照，并继续队列', () => {
  const first = normalTransition();
  const second = normalTransition();
  const transitions = [first, second];
  const harness = createHarness((update) => transitions.shift().start(update), '/detail');

  harness.controller.requestBack();
  harness.controller.requestBack();
  const pendingTimer = harness.timers.values().next().value;
  assert.equal(pendingTimer.delay, NATIVE_BACK_TRANSITION_TIMEOUT_MS);
  pendingTimer.callback();

  assert.equal(first.skipped, 1);
  assert.deepEqual(harness.navigations, ['/library', '/shelf']);
  assert.deepEqual(harness.activeStates.slice(0, 3), [true, false, true]);
});

test('显式 target 等于当前 pathname 不持锁，下一次 BACK 仍生效', () => {
  const harness = createHarness(() => {
    throw new Error('same-path navigation must not start a transition');
  }, '/detail');

  harness.controller.requestBack('/detail');
  harness.controller.requestBack();

  assert.deepEqual(harness.navigations, ['/detail', '/library']);
  assert.deepEqual(harness.activeStates, [false, true, false]);
});

test('桌面无动画模式从详情返回后再次进入详情仍可返回', () => {
  const navigations = [];
  const createController = (pathname) => new NativeBackTransitionController(pathname, {
    navigate: (target) => navigations.push(target),
    canAnimate: () => false,
    startViewTransition: () => {
      throw new Error('desktop must not start a view transition');
    },
    setTransitionActive: () => undefined,
  });

  let controller = createController('/detail');
  controller.requestBack();
  assert.deepEqual(navigations, ['/library']);
  controller.destroy();

  // Mirrors a provider effect recreated by a new Next router identity.
  controller = createController('/detail');
  controller.requestBack();
  assert.deepEqual(navigations, ['/library', '/library']);
});
