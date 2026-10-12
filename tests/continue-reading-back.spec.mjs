import { test, expect as baseExpect } from '@playwright/test';
import { installLibraryLayoutMock, openLayoutRoute, navigateLayoutRoute, LAYOUT_BOOK, LAYOUT_OFFLINE_BOOK, LAYOUT_SERVER_URL } from './helpers/library-layout.mjs';

// Detail history returns preserve runtime only when the browser restores the
// actual document; a fresh document must return to the saved server list.
test.use({ launchOptions: {
  executablePath: process.env.MOKE_TEST_CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
} });

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

// This exercises the Tauri frontend with a simulated native book/navigation
// bridge. It deliberately returns during Reader startup, before key interception.
const expect = baseExpect.configure({ timeout: 15_000 });

for (const entry of ['card', 'shortcut']) {
  test(`system BACK after ${entry} continue reading shows a normal detail`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installLibraryLayoutMock(page, {
      offlineMode: true, startup: entry === 'startup',
      nativeRuntime: 'android', nativeNavigation: true,
      nativeBooks: [LAYOUT_OFFLINE_BOOK],
    });
    await page.route('**/readest/reader?**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>模拟阅读器启动</title><h1>模拟阅读器启动</h1>',
    }));
    await openLayoutRoute(page, APP_URL, '/shelf', { offlineMode: true });
    if (entry === 'card') {
      await page.getByRole('link', { name: `继续阅读《${LAYOUT_BOOK.title}》` }).click();
    } else if (entry === 'shortcut') {
      await expect(page.getByRole('heading', { name: '我的书架' })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event('moke:continue-reading-request')));
    }
    await expect(page.getByRole('heading', { name: '模拟阅读器启动' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');
    // BFCache resumes an existing document without another DOMContentLoaded.
    await page.goBack({ waitUntil: 'commit' });
    await expect(page).toHaveURL(/\/detail\?id=42&source=/);
    const params = new URL(page.url()).searchParams;
    expect(params.has('continue')).toBe(false);
    expect(params.get('source')).toBe(LAYOUT_SERVER_URL);
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
    const read = page.getByTestId('offline-read-primary-action');
    await expect(read).toBeVisible();
    await expect(read).toHaveText('离线阅读');
    await expect(page.getByText(/^正在继续阅读/)).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');

    // Reload ends the runtime session. Re-enter offline mode explicitly; no
    // stale continue flag or one-use Reader receipt may relaunch the book.
    await page.reload();
    await expect(page.getByRole('heading', { name: '服务器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible();
    await navigateLayoutRoute(page, `/detail?id=42&source=${encodeURIComponent(LAYOUT_SERVER_URL)}`);
    await expect(read).toHaveText('离线阅读');
    await read.click();
    await expect(page.getByRole('heading', { name: '模拟阅读器启动' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('2');
  });
}
