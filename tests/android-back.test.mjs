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
const backNavigationSource = readFileSync(
  fileURLToPath(new URL('../src/components/providers/NativeBackNavigation.tsx', import.meta.url)),
  'utf8',
);
const globalStyles = readFileSync(
  fileURLToPath(new URL('../src/app/globals.css', import.meta.url)),
  'utf8',
);
const tabBarSource = readFileSync(
  fileURLToPath(new URL('../src/components/layout/TabBar.tsx', import.meta.url)),
  'utf8',
);
const rootLayoutSource = readFileSync(
  fileURLToPath(new URL('../src/app/layout.tsx', import.meta.url)),
  'utf8',
);
const showMokeStatusBarSource = activitySource.match(
  /private fun showMokeStatusBar\(darkMode: Boolean\)[\s\S]*?\n    }\n\n    @Suppress/,
)?.[0];

test('Android 应用根页返回键提供二次确认并退出任务', () => {
  assert.match(activitySource, /再按一次退出应用/);
  assert.match(activitySource, /finishAndRemoveTask\(\)/);
  assert.match(activitySource, /\/welcome/);
  assert.match(activitySource, /\/shelf/);
  assert.match(activitySource, /\/library/);
  assert.match(activitySource, /\/user/);
  assert.match(activitySource, /removeSuffix\("\.html"\)/);
});

test('底部三个主页标签不累积浏览历史', () => {
  assert.match(tabBarSource, /<Link[\s\S]*?replace[\s\S]*?href=\{tab\.href\}/);
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

test('Android Moke 主界面显式恢复顶部状态栏且不接管导航栏', () => {
  assert.ok(showMokeStatusBarSource);
  assert.match(activitySource, /fun showStatusBar\(darkMode: Boolean\)/);
  assert.match(showMokeStatusBarSource, /show\(WindowInsetsCompat\.Type\.statusBars\(\)\)/);
  assert.match(showMokeStatusBarSource, /isAppearanceLightStatusBars = !darkMode/);
  assert.doesNotMatch(showMokeStatusBarSource, /navigationBars\(\)/);
  assert.match(appShellSource, /showMokeSystemStatusBar\(platform, dark, window\.MokeWindowMode\)/);
});

test('Android 状态栏任务在 Activity 销毁竞态中安全退出', () => {
  assert.ok(showMokeStatusBarSource);
  assert.match(showMokeStatusBarSource, /runOnUiThread/);
  assert.match(
    showMokeStatusBarSource,
    /if \(isFinishing \|\| isDestroyed\) return@runOnUiThread/,
  );
  assert.match(showMokeStatusBarSource, /catch \(_: IllegalStateException\)/);
  assert.ok(
    showMokeStatusBarSource.indexOf('isFinishing || isDestroyed')
      < showMokeStatusBarSource.indexOf('WindowCompat.getInsetsController'),
  );
});

test('Android 返回先渲染上一页，再只把当前页向右划出', () => {
  assert.match(backNavigationSource, /document\.startViewTransition/);
  assert.match(backNavigationSource, /controllerRef\.current\?\.pathnameChanged\(pathname\)/);
  assert.match(globalStyles, /::view-transition-old\(root\)[\s\S]*animation-name: moke-native-back-exit/);
  assert.match(globalStyles, /::view-transition-new\(root\)[\s\S]*animation: none/);
  assert.match(globalStyles, /to \{ transform: translateX\(100%\); \}/);
});

test('首次原生返回可从 sessionStorage 恢复运行平台', () => {
  assert.match(
    backNavigationSource,
    /sessionStorage\.getItem\('moke-runtime-platform'\)/,
  );
});

test('跨文档动画跳过桌面、Web、启动重定向及无关导航', () => {
  assert.match(rootLayoutSource, /installMokeDocumentTransitionGuard/);
  assert.match(rootLayoutSource, /event\.viewTransition\?\.skipTransition\(\)/);
  assert.match(rootLayoutSource, /mokeReaderTransition = 'exit'/);
  assert.match(globalStyles, /@view-transition\s*\{\s*navigation: auto;/);
  assert.match(globalStyles, /data-moke-reader-transition='exit'/);
});
