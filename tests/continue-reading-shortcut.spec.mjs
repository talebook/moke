import { test, expect } from '@playwright/test';
import { installLibraryLayoutMock, LAYOUT_OFFLINE_BOOK, LAYOUT_SERVER_URL } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

async function installShortcutBridge(page, launch = false) {
  await page.addInitScript((launch) => {
    window.shortcutUpdates = [];
    window.MokeWindowMode = {
      isInMultiWindowMode: () => false,
      setContinueReadingShortcutEnabled: (enabled) => window.shortcutUpdates.push(enabled),
      consumeContinueReadingLaunch: () => {
        if (!launch || sessionStorage.getItem('shortcut-consumed')) return false;
        sessionStorage.setItem('shortcut-consumed', 'true');
        return true;
      },
    };
  }, launch);
}

async function saveRecord(page, entries) {
  await page.evaluate((entries) => {
    localStorage.setItem('moke-continue-reading', JSON.stringify({ version: 2, entries }));
    window.dispatchEvent(new Event('moke:continue-reading-changed'));
  }, entries);
}

const offlineEntry = {
  serverUrl: LAYOUT_SERVER_URL, mode: 'offline', bookId: '42', updatedAt: Date.now(),
};

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`shortcut follows saved reading availability at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installLibraryLayoutMock(page, { offlineMode: true, continueReading: false, nativeRuntime: 'android' });
    await installShortcutBridge(page);
    await page.goto(`${APP_URL}/shelf`);
    await expect(page.getByRole('heading', { name: '我的书架' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([false]);

    await saveRecord(page, { __offline__: offlineEntry });
    await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([false, true]);
    await saveRecord(page, { __offline__: { ...offlineEntry, progress: 0.4 } });
    expect(await page.evaluate(() => window.shortcutUpdates)).toEqual([false, true]);

    // The record persists after recreating the document; startup publishes it.
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([true]);
    await saveRecord(page, {});
    await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([true, false]);
    await page.evaluate(() => {
      localStorage.setItem('moke-continue-reading', '{broken');
      window.dispatchEvent(new Event('storage'));
    });
    expect(await page.evaluate(() => window.shortcutUpdates)).toEqual([true, false]);
  });
}

test('an online shortcut ignores another server and offline records', async ({ page }) => {
  await installLibraryLayoutMock(page, { continueReading: false, nativeRuntime: 'android' });
  await installShortcutBridge(page);
  await page.goto(`${APP_URL}/shelf`);
  await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([false]);
  await saveRecord(page, {
    '__offline__': offlineEntry,
    'https://other.books.test::online': { ...offlineEntry, mode: 'online', serverUrl: 'https://other.books.test' },
  });
  expect(await page.evaluate(() => window.shortcutUpdates)).toEqual([false]);
  await saveRecord(page, { [`${LAYOUT_SERVER_URL}::online`]: { ...offlineEntry, mode: 'online' } });
  await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([false, true]);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([false, true, false]);
});

test('disconnecting the server hides its reading shortcut', async ({ page }) => {
  await installLibraryLayoutMock(page, { nativeRuntime: 'android' });
  await installShortcutBridge(page);
  await page.goto(`${APP_URL}/settings`);
  await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([true]);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([true, false]);
});

test('reading a downloaded book enables the previously hidden shortcut', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installLibraryLayoutMock(page, {
    offlineMode: true, continueReading: false, nativeRuntime: 'android',
    nativeBooks: [LAYOUT_OFFLINE_BOOK], nativeNavigation: true, readerHandoffDelayMs: 1_000,
  });
  await installShortcutBridge(page);
  await page.route('**/readest/reader?**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<h1>模拟阅读器</h1>',
  }));
  await page.goto(`${APP_URL}/detail?id=42&source=${encodeURIComponent(LAYOUT_SERVER_URL)}`);
  await expect(page.getByTestId('offline-read-primary-action')).toBeVisible();
  expect(await page.evaluate(() => window.shortcutUpdates)).toEqual([false]);
  await page.getByTestId('offline-read-primary-action').click();
  await expect.poll(() => page.evaluate(() => window.shortcutUpdates)).toEqual([false, true]);
  await expect(page.getByRole('heading', { name: '模拟阅读器' })).toBeVisible();
});

test('a cold shortcut launch consumes the pending native request and opens the last book', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installLibraryLayoutMock(page, {
    offlineMode: true, nativeRuntime: 'android',
    nativeBooks: [LAYOUT_OFFLINE_BOOK], nativeNavigation: true,
  });
  await installShortcutBridge(page, true);
  await page.route('**/readest/reader?**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<h1>模拟阅读器</h1>',
  }));
  await page.goto(`${APP_URL}/`);
  await expect(page.getByRole('heading', { name: '模拟阅读器' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('shortcut-consumed'))).toBe('true');
  expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');
});
