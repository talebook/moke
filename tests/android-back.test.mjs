import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const activitySource = readFileSync(
  fileURLToPath(new URL('../src-tauri/android/MainActivity.kt', import.meta.url)),
  'utf8',
);

test('Android 应用根页返回键提供二次确认并退出任务', () => {
  assert.match(activitySource, /再按一次退出应用/);
  assert.match(activitySource, /finishAndRemoveTask\(\)/);
  assert.match(activitySource, /\/welcome/);
  assert.match(activitySource, /\/shelf/);
});

test('Android 非根页返回键交给 Next 路由且不覆盖阅读器拦截', () => {
  assert.match(activitySource, /moke:native-back/);
  assert.match(activitySource, /!interceptBackKeyEnabled/);
});
