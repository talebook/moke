import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAllowReaderExitTransition } from '../src/lib/document-transition.ts';

test('跨文档动画只允许移动端从 Readest 返回 Moke', () => {
  assert.equal(
    shouldAllowReaderExitTransition(
      'android',
      'tauri://localhost/readest/reader',
      'tauri://localhost/shelf',
    ),
    true,
  );
  assert.equal(
    shouldAllowReaderExitTransition(
      'ios',
      'tauri://localhost/readest',
      'tauri://localhost/library',
    ),
    true,
  );
  assert.equal(
    shouldAllowReaderExitTransition(
      'ohos',
      'tauri://localhost/readest/library',
      'tauri://localhost/user',
    ),
    true,
  );

  assert.equal(
    shouldAllowReaderExitTransition(
      'windows',
      'tauri://localhost/readest/reader',
      'tauri://localhost/shelf',
    ),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition(
      'web',
      'https://moke.example/readest/reader',
      'https://moke.example/shelf',
    ),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition(
      'android',
      'tauri://localhost/',
      'tauri://localhost/shelf',
    ),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition(
      'android',
      'tauri://localhost/shelf',
      'tauri://localhost/library',
    ),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition(
      'android',
      'https://evil.example/readest/reader',
      'tauri://localhost/shelf',
    ),
    false,
  );
  assert.equal(
    shouldAllowReaderExitTransition('android', 'not a url', 'tauri://localhost/shelf'),
    false,
  );
});

test('跨文档 guard 被序列化后仍可独立执行', () => {
  const serialized = shouldAllowReaderExitTransition.toString();
  const restored = Function(`return (${serialized})`)();
  assert.equal(
    restored(
      'android',
      'tauri://localhost/readest/reader',
      'tauri://localhost/shelf',
    ),
    true,
  );
});
