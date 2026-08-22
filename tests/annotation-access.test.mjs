import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRequestBookAnnotations } from '../src/lib/annotation-access.ts';

test('游客不请求需要登录的书籍标注接口', () => {
  assert.equal(shouldRequestBookAnnotations(false), false);
  assert.equal(shouldRequestBookAnnotations(true), true);
});
