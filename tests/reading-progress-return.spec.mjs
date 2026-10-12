import { test, expect as baseExpect } from '@playwright/test';

// Shared-host dev hydration and native module imports can exceed five seconds.
const expect = baseExpect.configure({ timeout: 15_000 });
import { installLibraryLayoutMock, openLayoutRoute, navigateLayoutRoute, LAYOUT_BOOK, LAYOUT_OFFLINE_BOOK, LAYOUT_SERVER_URL } from './helpers/library-layout.mjs';

// Detail history returns preserve runtime only when the browser restores the
// actual document; a fresh document must return to the saved server list.
test.use({ launchOptions: {
  executablePath: process.env.MOKE_TEST_CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
} });

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const detail = `/detail?id=42&source=${encodeURIComponent(LAYOUT_SERVER_URL)}`;
const reader = '<!doctype html><meta charset="utf-8"><h1>模拟阅读器</h1><script>sessionStorage.setItem("returning", "true")</script>';

async function installReturnMock(page, { offlineMode = true, fail = false, needLogin = false } = {}) {
  await installLibraryLayoutMock(page, {
    offlineMode, nativeRuntime: 'android', nativeNavigation: true,
    nativeBooks: [LAYOUT_OFFLINE_BOOK], returnBookPayload: needLogin ? { err: 'user.need_login' } : null,
  });
  await page.route('**/readest/reader?**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: reader }));
  await page.addInitScript(({ offlineMode, fail }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const pending = [];
    let released = false;
    window.returnQuery = { pending: false, release: () => { released = true; pending.splice(0).forEach((resolve) => resolve()); } };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const returning = sessionStorage.getItem('returning') === 'true';
      const query = offlineMode ? command === 'moke_list_downloaded_books'
        : command === 'plugin:http|fetch' && args.clientConfig.url.endsWith('/api/book/42');
      if (returning && query && !released) {
        window.returnQuery.pending = true;
        await new Promise((resolve) => { pending.push(resolve); });
        if (fail) {
          if (offlineMode) return []; // The just-read local file was removed.
          throw new Error('fixture return query failed');
        }
      }
      return invoke(command, args);
    };
  }, { offlineMode, fail });
}

for (const offlineMode of [true, false]) {
  for (const fail of [false, true]) {
    test(`${offlineMode ? 'offline' : 'online'} Reader return shows detail before ${fail ? offlineMode ? 'missing-book' : 'failed' : 'slow'} revalidation`, async ({ page }) => {
      await installReturnMock(page, { offlineMode, fail });
      await openLayoutRoute(page, APP_URL, detail, { offlineMode });
      await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
      // Both modes open the downloaded EPUB; live metadata uses native or HTTP.
      await page.getByTestId(offlineMode ? 'offline-read-primary-action' : 'offline-download-action').click();
      await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
      await page.goBack({ waitUntil: 'commit' });
      await page.waitForFunction(() => window.returnQuery?.pending);
      await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
      await expect(page.getByText('正在更新书籍信息…', { exact: true })).toBeVisible();
      await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
      await expect(page.getByTestId(offlineMode ? 'offline-read-primary-action' : 'offline-download-action')).toBeDisabled();
      await expect(page.getByRole('button', { name: '移出书架', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');
      await page.evaluate(() => window.returnQuery.release());
      if (fail) {
        await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toHaveCount(0);
        await expect(page.getByText('书籍详情加载失败，请检查服务器连接。', { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText('正在更新书籍信息…', { exact: true })).toHaveCount(0);
        await expect(page.getByTestId(offlineMode ? 'offline-read-primary-action' : 'offline-download-action')).toBeEnabled();
      }
    });
  }
}

for (const appearance of ['normal', 'reduced', 'eink']) {
  test(`continue reading shows real stages with ${appearance} progress text`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (appearance === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLibraryLayoutMock(page, {
      offlineMode: true, nativeRuntime: 'android', nativeNavigation: true,
      nativeBooks: [LAYOUT_OFFLINE_BOOK], readerHandoffDelayMs: 100,
      previewDelayMs: 300, eink: appearance === 'eink',
    });
    await page.route('**/readest/reader?**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: reader }));
    await page.addInitScript(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const bookWaiters = [], readerWaiters = [];
      let bookReleased = false, readerReleased = false;
      window.stageQuery = {
        releaseBook: () => { bookReleased = true; bookWaiters.splice(0).forEach((resolve) => resolve()); },
        releaseReader: () => { readerReleased = true; readerWaiters.splice(0).forEach((resolve) => resolve()); },
      };
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'moke_list_downloaded_books' && !bookReleased) {
          await new Promise((resolve) => bookWaiters.push(resolve));
        }
        if (command === 'moke_navigate' && args.path.startsWith('/readest/') && !readerReleased) {
          await new Promise((resolve) => readerWaiters.push(resolve));
        }
        return invoke(command, args);
      };
      const sample = () => {
        const node = document.querySelector('[data-testid="app-startup-screen"]');
        if (node) {
          const stages = JSON.parse(sessionStorage.getItem('reading-stages') || '[]');
          const message = node.getAttribute('data-progress-message');
          if (!stages.includes(message)) { stages.push(message); sessionStorage.setItem('reading-stages', JSON.stringify(stages)); }
        }
        if (location.pathname.startsWith('/readest/')) return;
        requestAnimationFrame(sample);
      };
      document.addEventListener('DOMContentLoaded', sample, { once: true });
    });
    await openLayoutRoute(page, APP_URL, detail + '&continue=1', { offlineMode: true });
    await expect(page.getByTestId('app-startup-screen')).toHaveAttribute('data-progress-message', '正在打开上次阅读的书籍…');
    await page.evaluate(() => window.stageQuery.releaseBook());
    await expect(page.getByTestId('app-startup-screen')).toHaveAttribute('data-progress-message', '正在打开阅读器…');
    const animation = await page.locator('.moke-progress-text').evaluate((line) => ({
      overflow: getComputedStyle(line).overflow,
      oldAnimation: getComputedStyle(line.querySelector('.moke-progress-text-old')).animationName,
      oldDisplay: getComputedStyle(line.querySelector('.moke-progress-text-old')).display,
      newAnimation: getComputedStyle(line.querySelector('.moke-progress-text-new')).animationName,
    }));
    expect(animation.overflow).toBe('hidden');
    if (appearance === 'normal') {
      expect(animation.oldAnimation).toBe('moke-progress-out');
      expect(animation.newAnimation).toBe('moke-progress-in');
    } else {
      expect(animation.oldDisplay).toBe('none');
      expect(animation.newAnimation).toBe('none');
    }
    await page.evaluate(() => window.stageQuery.releaseReader());
    await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
    const stages = await page.evaluate(() => JSON.parse(sessionStorage.getItem('reading-stages')));
    expect(stages).toContain('正在验证使用资格…');
    expect(stages).toContain('正在打开上次阅读的书籍…');
    expect(stages).toContain('正在打开阅读器…');
    expect(stages).not.toContain('正在打开 Moke…');
  });
}


test('expired authorization removes the return snapshot and routes to login', async ({ page }) => {
  await installReturnMock(page, { offlineMode: false, needLogin: true });
  await openLayoutRoute(page, APP_URL, detail);
  await page.getByTestId('offline-download-action').click();
  await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => window.returnQuery?.pending);
  await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
  await page.evaluate(() => window.returnQuery.release());
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toHaveCount(0);
  await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
});

for (const change of ['cold-reload', 'fresh-link']) {
  test(`${change} cannot restore the previous Reader snapshot or runtime session`, async ({ page }) => {
    await installReturnMock(page);
    await openLayoutRoute(page, APP_URL, detail, { offlineMode: true });
    await page.getByTestId('offline-read-primary-action').click();
    await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
    await page.goto(APP_URL + detail, { waitUntil: 'commit' });
    if (change === 'cold-reload') await page.reload({ waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: '服务器', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toHaveCount(0);
    await expect(page.getByText('正在更新书籍信息…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
    // Release the native library query only after the explicit offline action;
    // a cold link itself cannot consume the Reader's /library return receipt.
    await page.waitForFunction(() => window.returnQuery?.pending);
    await page.evaluate(() => window.returnQuery.release());
    await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible();
    await navigateLayoutRoute(page, detail);
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
    await expect(page.getByTestId('offline-read-primary-action')).toBeEnabled();
  });
}
