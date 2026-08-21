import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAllowReaderExitTransition } from '../src/lib/document-transition.ts';

test('跨文档动画只允许移动端从 Readest 返回 Moke', () => {
  assert.equal(
    shouldAllowReaderExitTransition('android', 'tauri://localhost/readest/reader'),
    true,
  );
  assert.equal(
    shouldAllowReaderExitTransition('ios', 'tauri://localhost/readest'),
    true,
  );
  assert.equal(
    shouldAllowReaderExitTransition('ohos', 'tauri://localhost/readest/library'),
    true,
  );

  assert.equal(
    shouldAllowReaderExitTransition('windows', 'tauri://localhost/readest/reader'),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition('web', 'https://moke.example/readest/reader'),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition('android', 'tauri://localhost/'),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition('android', 'tauri://localhost/shelf'),
    false,
  );
  assert.equal(shouldAllowReaderExitTransition('android', 'not a url'), false);
});
