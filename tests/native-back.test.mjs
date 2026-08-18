import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nativeBackFallback,
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
