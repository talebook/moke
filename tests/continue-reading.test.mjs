import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  continueReadingHref,
  getContinueReading,
  latestContinueReadingFromHistory,
  rememberContinueReading,
} from '../src/lib/continue-reading.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('在线最近阅读按服务器隔离，离线模式使用独立记录并保留书籍元数据', () => {
  const storage = memoryStorage();
  rememberContinueReading({
    serverUrl: 'HTTPS://BOOKS.EXAMPLE/path/',
    bookId: '42',
    title: '测试书籍',
    author: '作者',
    cover: '/cover/42.jpg',
    updatedAt: 1_000,
  }, storage);
  rememberContinueReading({
    serverUrl: 'https://books.example',
    bookId: '42',
    progress: 0.35,
    page: 35,
    totalPages: 100,
    updatedAt: 2_000,
  }, storage);
  rememberContinueReading({
    serverUrl: 'https://other.example',
    bookId: '7',
    title: '另一本书',
    updatedAt: 3_000,
  }, storage);
  rememberContinueReading({
    serverUrl: 'https://books.example',
    mode: 'offline',
    bookId: '99',
    title: '离线最近阅读',
    updatedAt: 4_000,
  }, storage);

  assert.deepEqual(getContinueReading('https://books.example/', 'online', storage), {
    serverUrl: 'https://books.example',
    mode: 'online',
    bookId: '42',
    title: '测试书籍',
    author: '作者',
    cover: '/cover/42.jpg',
    format: undefined,
    progress: 0.35,
    page: 35,
    totalPages: 100,
    updatedAt: 2_000,
  });
  assert.equal(getContinueReading('https://other.example', 'online', storage)?.bookId, '7');
  assert.equal(getContinueReading('', 'offline', storage)?.bookId, '99');
  assert.equal(getContinueReading('https://other.example', 'offline', storage)?.bookId, '99');
});

test('首次升级可从服务端阅读历史选出最近一本并规范秒级时间戳', () => {
  const entry = latestContinueReadingFromHistory('https://books.example', [
    { id: 1, title: '较早', timestamp: 1_700_000_000 },
    {
      id: 2,
      title: '最近',
      authors: [{ name: '甲' }, { name: '乙' }],
      thumb: '/cover/2.jpg',
      files: [{ format: 'EPUB' }],
      timestamp: 1_800_000_000,
    },
  ]);

  assert.deepEqual(entry, {
    serverUrl: 'https://books.example',
    mode: 'online',
    bookId: '2',
    title: '最近',
    author: '甲、乙',
    cover: '/cover/2.jpg',
    format: 'epub',
    updatedAt: 1_800_000_000_000,
  });
  assert.equal(continueReadingHref(entry), '/detail?id=2&continue=1');
  assert.equal(
    continueReadingHref({ ...entry, mode: 'offline' }),
    '/detail?id=2&continue=1&source=https%3A%2F%2Fbooks.example',
  );
});

test('Android 静态快捷方式与原生 Intent 桥使用同一个继续阅读动作', () => {
  const shortcuts = readFileSync(new URL('../src-tauri/mobile/android/xml/shortcuts.xml', import.meta.url), 'utf8');
  const activity = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8');
  const action = 'org.houheya.moke.action.CONTINUE_READING';

  assert.match(shortcuts, /android:shortcutId="continue_reading"/);
  assert.ok(shortcuts.includes(`android:action="${action}"`));
  assert.ok(activity.includes(`CONTINUE_READING_ACTION = "${action}"`));
  assert.match(activity, /override fun onNewIntent\(intent: Intent\)/);
  assert.match(activity, /consumeContinueReadingLaunch/);
});

test('三种继续阅读入口都接入统一自动阅读链接', () => {
  const settingsStore = readFileSync(new URL('../src/lib/store/settings.ts', import.meta.url), 'utf8');
  const settingsPage = readFileSync(new URL('../src/app/settings/page.tsx', import.meta.url), 'utf8');
  const homePage = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  const shelfPage = readFileSync(new URL('../src/app/shelf/page.tsx', import.meta.url), 'utf8');
  const detailPage = readFileSync(new URL('../src/app/detail/page.tsx', import.meta.url), 'utf8');

  assert.match(settingsStore, /continueReadingOnLaunch: false/);
  assert.match(settingsPage, /label="启动时继续上次阅读"/);
  assert.match(homePage, /continueReadingOnLaunch[\s\S]*continueReadingHref/);
  assert.match(shelfPage, />继续阅读</);
  assert.match(shelfPage, /href=\{continueReadingHref\(continueReading\)\}/);
  assert.match(detailPage, /searchParams\.get\('continue'\) === '1'/);
  assert.match(detailPage, /offlineMode \|\| downloaded[\s\S]*handleOfflineRead/);
  assert.match(detailPage, /else if \(onlineFormat\) open = handleOnlineRead/);
});
