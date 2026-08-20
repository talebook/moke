import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const activitySource = readFileSync(
  fileURLToPath(new URL('../src-tauri/android/MainActivity.kt', import.meta.url)),
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

test('Android 返回先渲染上一页，再只把当前页向右划出', () => {
  assert.match(backNavigationSource, /document\.startViewTransition/);
  assert.match(backNavigationSource, /pending\.target === pathname/);
  assert.match(globalStyles, /::view-transition-old\(root\)[\s\S]*animation-name: moke-native-back-exit/);
  assert.match(globalStyles, /::view-transition-new\(root\)[\s\S]*animation: none/);
  assert.match(globalStyles, /to \{ transform: translateX\(100%\); \}/);
});

test('任意 Readest 文档退出都会触发 Moke 返回动画', () => {
  assert.match(rootLayoutSource, /pagereveal/);
  assert.match(rootLayoutSource, /fromPath\.startsWith\('\/readest\/'\)/);
  assert.match(rootLayoutSource, /mokeReaderTransition = 'exit'/);
  assert.match(globalStyles, /@view-transition\s*\{\s*navigation: auto;/);
  assert.match(globalStyles, /data-moke-reader-transition='exit'/);
});
