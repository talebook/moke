import { test, expect } from '@playwright/test';
import { installAuthNavigationMock } from './helpers/auth-navigation.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const DOWNLOAD_PATH = /\/api\/book\/\d+\.(?:epub|cbz)$/;

async function expectLogin(page, returnTo) {
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe('/login');
  expect(url.searchParams.get('returnTo')).toBe(returnTo);
}

async function countDownloads(page) {
  return page.evaluate(() => window.__AUTH_TEST_REQUESTS__.filter(url => /\/api\/book\/\d+\.(?:epub|cbz)$/.test(new URL(url).pathname)).length);
}

for (const failure of ['http401', 'need_login']) {
  for (const action of ['online', 'download']) {
    test(`detail ${action} opens login for ${failure} and preserves the book`, async ({ page }) => {
      await installAuthNavigationMock(page, { failure });
      await page.goto(`${APP_URL}/detail?id=42`);
      await page.getByTestId(action === 'online' ? 'online-read-action' : 'offline-download-action').click();
      await expectLogin(page, '/detail?id=42');
      if (failure === 'need_login' && action === 'download') {
        const before = await countDownloads(page);
        await page.getByPlaceholder('请输入用户名').fill('fixture-reader');
        await page.getByPlaceholder('请输入密码').fill('fixture-password');
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page).toHaveURL(`${APP_URL}/detail?id=42`);
        await expect(page.getByTestId('offline-download-action')).toBeEnabled();
        expect(await countDownloads(page)).toBe(before);
      }
    });
  }
}

for (const [action, failure, message] of [
  ['online', 'permission', '当前账号没有在线阅读权限'],
  ['download', 'permission', '下载失败'],
  ['download', 'transfer', '下载中断'],
]) {
  test(`detail ${action} keeps ${failure} failures on the book page`, async ({ page }) => {
    await installAuthNavigationMock(page, { failure });
    await page.goto(`${APP_URL}/detail?id=42`);
    await page.getByTestId(action === 'online' ? 'online-read-action' : 'offline-download-action').click();
    await expect(page.getByText(message, { exact: false })).toBeVisible();
    await expect(page).toHaveURL(`${APP_URL}/detail?id=42`);
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toHaveCount(0);
  });
}

for (const route of ['/library', '/shelf', '/search?q=fixture']) {
  for (const batch of [false, true]) {
    test(`${route} ${batch ? 'batch stops on' : 'single download opens'} authentication failure`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await installAuthNavigationMock(page);
      await page.goto(`${APP_URL}${route}`);
      await page.locator('a[href="/detail?id=42"]').first().click({ button: 'right' });
      if (batch) {
        await page.getByRole('menuitem', { name: '选择多本', exact: true }).click();
        await page.getByRole('button', { name: '全选', exact: true }).click();
        await page.getByRole('button', { name: '下载', exact: true }).click();
      } else {
        await page.getByRole('menuitem', { name: '下载', exact: true }).click();
      }
      await expectLogin(page, route);
      expect(await countDownloads(page)).toBe(1);
    });
  }
}

for (const batch of [false, true]) {
  test(`download manager ${batch ? 'batch stops' : 'retry opens login'} on authentication failure`, async ({ page }) => {
    await installAuthNavigationMock(page, { pausedDownloads: true });
    await page.goto(`${APP_URL}/downloads`);
    if (batch) {
      await page.getByRole('checkbox', { name: '选择登录导航测试书籍 42', exact: true }).check();
      await page.getByRole('checkbox', { name: '选择登录导航测试书籍 43', exact: true }).check();
      await page.getByRole('button', { name: '批量继续/重试', exact: true }).click();
    } else await page.getByTitle('继续或重试').first().click();
    await expectLogin(page, '/downloads');
    expect(await countDownloads(page)).toBe(1);
  });
}

for (const failure of ['http401', 'need_login', 'permission']) {
  test(`comic online read handles ${failure} without treating permission as login`, async ({ page }) => {
    await installAuthNavigationMock(page, { failure, comic: true });
    await page.goto(`${APP_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click();
    if (failure === 'permission') {
      await expect(page.locator('.moke-comic-state')).toContainText('权限');
      await expect(page).toHaveURL(`${APP_URL}/detail?id=42`);
    } else await expectLogin(page, '/detail?id=42');
  });
}

test('login ignores an external return target after a successful form submission', async ({ page }) => {
  await installAuthNavigationMock(page);
  await page.goto(`${APP_URL}/login?returnTo=${encodeURIComponent('https://evil.test/detail')}`);
  await page.getByPlaceholder('请输入用户名').fill('fixture-reader');
  await page.getByPlaceholder('请输入密码').fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(`${APP_URL}/shelf`);
  expect((await page.evaluate(() => window.__AUTH_TEST_REQUESTS__)).every(url => !DOWNLOAD_PATH.test(new URL(url).pathname))).toBe(true);
});

test('comic personal progress alone cannot redirect a successfully opened book to login', async ({ page }) => {
  await installAuthNavigationMock(page, { failure: 'progress_only', comic: true });
  await page.goto(`${APP_URL}/detail?id=42`);
  await page.getByTestId('online-read-action').click();
  await expect(page.locator('.kr-page-count')).toHaveText('1 / 1');
  await expect(page.locator('.moke-comic-notice')).toContainText('权限');
  await expect(page).toHaveURL(`${APP_URL}/detail?id=42`);
  expect(await page.evaluate(() => window.__AUTH_TEST_REQUESTS__.some(url => url.endsWith('/comic/progress')))).toBe(true);
});

for (const batch of [false, true]) {
  test(`late 401 after leaving ${batch ? 'a batch download' : 'book detail'} cannot replace the new page`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installAuthNavigationMock(page, { deferFailure: true });
    await page.goto(`${APP_URL}${batch ? '/library' : '/detail?id=42'}`);
    if (batch) {
      await page.locator('a[href="/detail?id=42"]').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: '选择多本', exact: true }).click();
      await page.getByRole('button', { name: '全选', exact: true }).click();
      await page.getByRole('button', { name: '下载', exact: true }).click();
    } else await page.getByTestId('offline-download-action').click();
    await expect.poll(() => countDownloads(page)).toBe(1);
    await page.getByRole('link', { name: '书架', exact: true }).click();
    await expect(page).toHaveURL(`${APP_URL}/shelf`);
    await page.evaluate(() => window.__AUTH_TEST_RELEASE_FAILURE__());
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('moke-offline-download-tasks-v1') || '[]')
      .some(item => item.bookId === '42' && item.status === 'failed'))).toBe(true);
    await expect(page).toHaveURL(`${APP_URL}/shelf`);
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toHaveCount(0);
    expect(await countDownloads(page)).toBe(1);
  });
}
