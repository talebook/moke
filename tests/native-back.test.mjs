import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_BACK_EVENT,
  nativeBackFallback,
  requestAnimatedBack,
  resolveNativeBackTarget,
} from '../src/lib/native-back.ts';

test('原生返回优先使用应用内路由栈，不依赖浏览器历史', () => {
  assert.deepEqual(resolveNativeBackTarget('/detail', ['/shelf', '/library', '/detail']), {
    target: '/library',
    nextStack: ['/shelf', '/library'],
  });
});

test('刷新后路由栈为空时返回确定的上级页面', () => {
  assert.equal(nativeBackFallback('/settings/developer'), '/settings');
  assert.equal(nativeBackFallback('/user/history'), '/user');
  assert.equal(nativeBackFallback('/detail'), '/library');
  assert.deepEqual(resolveNativeBackTarget('/search', []), {
    target: '/shelf',
    nextStack: [],
  });
});

test('页面返回按钮与 Android 系统返回触发同一个动画事件', () => {
  const windowTarget = new EventTarget();
  let received = 0;
  let target;
  windowTarget.addEventListener(APP_BACK_EVENT, (event) => {
    received += 1;
    target = event.detail.target;
  });
  Object.defineProperty(globalThis, 'window', {
    value: windowTarget,
    configurable: true,
  });

  try {
    requestAnimatedBack('/settings');
    assert.equal(received, 1);
    assert.equal(target, '/settings');
  } finally {
    delete globalThis.window;
  }
});
