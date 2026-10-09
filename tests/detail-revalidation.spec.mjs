import { test, expect } from '@playwright/test';
import {
  installDetailRevalidationMock, installReadyAnnotationsMock, installAccountCancellationMock,
  REVALIDATION_DETAIL, LAYOUT_BOOK,
} from './helpers/detail-revalidation.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
test.use({ launchOptions: {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
} });

// Persisted-document cases run against the production export. Next dev's HMR
// WebSocket evicts the document; cancellation and account sync also run in dev.
for (const outcome of ['ok', 'missing', 'permission', 'account']) {
  test(`real persisted bfcache return revalidates ${outcome} before enabling actions`, async ({ page }) => {
    const offlineMode = outcome !== 'permission';
    await installDetailRevalidationMock(page, { offlineMode, outcome });
    await page.goto(APP_URL + REVALIDATION_DETAIL);
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
    const before = await page.evaluate(() => ({ marker: window.revalidation.marker, queries: window.revalidation.queries }));
    await page.getByTestId(offlineMode ? 'offline-read-primary-action' : 'offline-download-action').click();
    await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
    if (outcome === 'account') await page.evaluate(() => {
      const storage = JSON.parse(localStorage.getItem('moke-server-storage'));
      storage.state.user.id = 2;
      localStorage.setItem('moke-server-storage', JSON.stringify(storage));
    });
    await page.goBack({ waitUntil: 'commit' });
    // This assertion rejects a synthetic event or a fresh document reload.
    await page.waitForFunction(() => window.revalidation?.pageshows.includes(true));
    expect(await page.evaluate(() => window.revalidation.marker)).toBe(before.marker);
    await page.waitForFunction(() => window.revalidation.pending);
    expect(await page.evaluate(() => window.revalidation.queries)).toBeGreaterThan(before.queries);
    expect(await page.evaluate(() => sessionStorage.getItem('moke-detail-return'))).toBeNull();
    await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    if (outcome === 'account') {
      await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toHaveCount(0);
    } else {
      await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
      await expect(page.getByText('正在更新书籍信息…', { exact: true })).toBeVisible();
      await expect(page.getByTestId(offlineMode ? 'offline-read-primary-action' : 'offline-download-action')).toBeDisabled();
    }
    await page.evaluate(() => window.revalidation.release());
    if (outcome === 'permission') await expect(page).toHaveURL(/\/login$/);
    else if (outcome === 'missing') await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toHaveCount(0);
    else await expect(page.getByTestId('offline-read-primary-action')).toBeEnabled();
    expect(await page.evaluate(() => sessionStorage.getItem('layout-reader-opens'))).toBe('1');
  });
}

for (const fail of [false, true]) {
  test(`account sync cancels an already suspended opener after IPC ${fail ? 'failure' : 'success'}`, async ({ page }) => {
    await installAccountCancellationMock(page, { fail });
    await page.goto(APP_URL + REVALIDATION_DETAIL + '&continue=1');
    await page.waitForFunction(() => window.accountRace.pending
      && document.querySelector('[data-testid="app-startup-screen"]')?.getAttribute('data-progress-message') === '正在读取书籍并恢复阅读进度…');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.user.id)).toBe(1);
    await page.evaluate(() => window.accountRace.releaseUser());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.user.id === 2
      && window.accountRace.bookResponses >= 2);
    await page.evaluate(() => window.accountRace.releasePlatform());
    await page.waitForFunction(() => window.accountRace.settled > 0);
    await expect(page.getByTestId('app-startup-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: LAYOUT_BOOK.title })).toBeVisible();
    await expect(page.getByTestId('offline-download-action')).toBeEnabled();
    expect(await page.evaluate(() => window.accountRace.opens)).toEqual([]);
    await expect(page).not.toHaveURL(/continue=1|readest/);
  });
}

test('ready annotations and an existing composer are read-only while the book revalidates', async ({ page }) => {
  await installDetailRevalidationMock(page, { offlineMode: false });
  await installReadyAnnotationsMock(page);
  await page.goto(APP_URL + REVALIDATION_DETAIL);
  await page.getByRole('button', { name: '新增笔记', exact: true }).click();
  await page.locator('textarea').fill('返回后保存');
  await expect(page.getByRole('button', { name: '精确定位', exact: true })).toBeEnabled();
  await page.getByTestId('offline-download-action').click();
  await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => window.revalidation.pending && window.revalidation.pageshows.includes(true));
  await expect(page.getByText('正在更新书籍信息…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '精确定位', exact: true })).toBeDisabled();
  // Dispatch events directly as well: handler protection cannot rely on disabled.
  await page.getByRole('button', { name: '保存笔记', exact: true }).dispatchEvent('click');
  await page.getByRole('button', { name: '精确定位', exact: true }).dispatchEvent('click');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.annotationRace.posts)).toBe(0);
  expect(await page.evaluate(() => window.annotationRace.opens)).toBe(1);
  await page.evaluate(() => window.revalidation.release());
  await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.annotationRace.posts)).toBe(1);
  await expect(page.getByRole('button', { name: '新增笔记', exact: true })).toBeVisible();
});

test('a delayed annotation response cannot retry a write across revalidation', async ({ page }) => {
  await installDetailRevalidationMock(page, { offlineMode: false });
  await installReadyAnnotationsMock(page, { deferFirstPost: true });
  await page.goto(APP_URL + REVALIDATION_DETAIL);
  await page.getByRole('button', { name: '新增笔记', exact: true }).click();
  await page.locator('textarea').fill('复验前草稿');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.waitForFunction(() => window.annotationRace.posts === 1);
  await page.getByTestId('offline-download-action').click();
  await expect(page.getByRole('heading', { name: '模拟阅读器', exact: true })).toBeVisible();
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => window.revalidation.pending && window.revalidation.pageshows.includes(true));
  await page.evaluate(() => window.annotationRace.releasePost());
  // The 429 would normally trigger a retry. Wait until that promise settles.
  await expect(page.getByRole('button', { name: '保存中', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.annotationRace.posts)).toBe(1);
  await page.evaluate(() => window.revalidation.release());
  await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
  await expect(page.locator('textarea')).toHaveValue('复验前草稿');
  expect(await page.evaluate(() => window.annotationRace.posts)).toBe(1);
});
