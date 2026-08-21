import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { shouldPreventNativeAppZoomShortcut } from '../src/lib/native-app-zoom.ts';

const readSource = (relativePath) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

const layoutSource = readSource('../src/app/layout.tsx');
const appShellSource = readSource('../src/components/providers/AppShell.tsx');
const globalStyles = readSource('../src/app/globals.css');

const shortcut = (overrides = {}) => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  ...overrides,
});

test('原生应用 viewport 禁止页面缩放但保留 Web 构建的浏览器缩放', () => {
  assert.match(layoutSource, /NEXT_PUBLIC_APP_PLATFORM === 'tauri'/);
  assert.match(layoutSource, /maximumScale: 1, userScalable: false/);
  assert.match(layoutSource, /data-moke-native-app=\{isNativeAppBuild \? '' : undefined\}/);
  assert.match(globalStyles, /html\[data-moke-native-app\][\s\S]*touch-action: pan-x pan-y/);
});

test('识别桌面端 WebView 的键盘缩放快捷键', () => {
  assert.equal(shouldPreventNativeAppZoomShortcut(shortcut({ ctrlKey: true, key: '=' })), true);
  assert.equal(shouldPreventNativeAppZoomShortcut(shortcut({ metaKey: true, key: '+' })), true);
  assert.equal(shouldPreventNativeAppZoomShortcut(shortcut({ ctrlKey: true, code: 'NumpadSubtract' })), true);
  assert.equal(shouldPreventNativeAppZoomShortcut(shortcut({ ctrlKey: true, key: '0' })), true);
  assert.equal(shouldPreventNativeAppZoomShortcut(shortcut({ key: '+' })), false);
  assert.equal(shouldPreventNativeAppZoomShortcut(shortcut({ ctrlKey: true, key: 'a' })), false);
});

test('原生应用拦截触控板和 Safari 手势缩放', () => {
  assert.match(appShellSource, /addEventListener\('wheel', preventWheelZoom, nonPassive\)/);
  assert.match(appShellSource, /event\.ctrlKey/);
  assert.match(appShellSource, /addEventListener\('gesturestart', preventGestureZoom, nonPassive\)/);
  assert.match(appShellSource, /addEventListener\('gesturechange', preventGestureZoom, nonPassive\)/);
  assert.match(appShellSource, /shouldPreventNativeAppZoomShortcut\(event\)/);
});
