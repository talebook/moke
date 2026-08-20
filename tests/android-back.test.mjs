import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const activitySource = readFileSync(
  fileURLToPath(new URL('../src-tauri/android/MainActivity.kt', import.meta.url)),
  'utf8',
);
const appShellSource = readFileSync(
  fileURLToPath(new URL('../src/components/providers/AppShell.tsx', import.meta.url)),
  'utf8',
);

test('Android 应用根页返回键提供二次确认并退出任务', () => {
  assert.match(activitySource, /再按一次退出应用/);
  assert.match(activitySource, /finishAndRemoveTask\(\)/);
  assert.match(activitySource, /\/welcome/);
  assert.match(activitySource, /\/shelf/);
  assert.match(activitySource, /removeSuffix\("\.html"\)/);
});

test('Android 非根页返回键交给 Next 路由且不覆盖阅读器拦截', () => {
  assert.match(activitySource, /moke:native-back/);
  assert.match(activitySource, /!interceptBackKeyEnabled/);
  assert.match(activitySource, /isEmbeddedReaderRoute\(\)/);
});

test('Android 分屏时通过原生窗口状态移除重复的顶部安全区', () => {
  assert.match(activitySource, /@JavascriptInterface/);
  assert.match(activitySource, /WeakReference<MainActivity>/);
  assert.match(activitySource, /addJavascriptInterface\(WindowModeBridge\(this\), "MokeWindowMode"\)/);
  assert.match(activitySource, /removeJavascriptInterface\("MokeWindowMode"\)/);
  assert.match(activitySource, /onMultiWindowModeChanged\(isInMultiWindowMode: Boolean\)/);
  assert.match(activitySource, /moke:window-mode-change/);
  assert.match(activitySource, /catch \(_: IllegalStateException\)/);
  assert.match(appShellSource, /MokeWindowMode\?\.isInMultiWindowMode\(\)/);
  assert.match(appShellSource, /shouldApplyTopSafeArea\(platform, isMultiWindow\)/);
  assert.match(appShellSource, /requestAnimationFrame/);
  assert.match(appShellSource, /addEventListener\('resize', scheduleSafeAreaRefresh\)/);
  assert.match(
    appShellSource,
    /addEventListener\('moke:window-mode-change', scheduleSafeAreaRefresh\)/,
  );
});
