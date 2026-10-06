import { test, expect } from '@playwright/test';
import { installLibraryLayoutMock, LAYOUT_BOOK } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const viewports = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 900 },
];

async function expectHeaderLayout(page) {
  await expect(page.getByRole('button', { name: '网格视图', exact: true })).toBeVisible();
  const layout = await page.locator('header').evaluate((header) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    };
    const toggle = header.querySelector('button[aria-label="网格视图"]').parentElement;
    const history = header.querySelector('a[aria-label="查看历史记录"]');
    return {
      title: rect(header.querySelector('h1')), toggle: rect(toggle),
      search: rect(header.querySelector('input[type="search"]')),
      history: history ? rect(history) : null,
      contentRight: header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(layout.toggle.bottom).toBeLessThan(layout.search.y);
  expect(layout.toggle.x).toBeGreaterThan(layout.title.right);
  expect(layout.toggle.y).toBeLessThan(layout.title.bottom);
  expect(layout.toggle.bottom).toBeGreaterThan(layout.title.y);
  expect(layout.toggle.right).toBeCloseTo(layout.contentRight, 0);
  expect(layout.overflow).toBe(false);
  if (layout.history) {
    expect(layout.history.bottom).toBeLessThan(layout.search.y);
    expect(layout.history.x).toBeGreaterThan(layout.title.right);
  }
}

for (const viewport of viewports) {
  test(`header actions and search work at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installLibraryLayoutMock(page);
    for (const route of ['/shelf', '/library', '/search?q=布局', '/search?scope=shelf&q=布局']) {
      await page.goto(`${APP_URL}${route}`);
      await expectHeaderLayout(page);
      const listButton = page.getByRole('button', { name: '列表视图', exact: true }).filter({ visible: true });
      await listButton.focus();
      await expect(listButton).toBeFocused();
      await page.keyboard.press('Enter');
      const key = route.startsWith('/shelf') ? 'shelfViewMode' : route.startsWith('/library') ? 'libraryViewMode' : 'searchViewMode';
      await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem('moke-view-prefs')).state[key], key)).toBe('list');
      if (viewport.width >= 768) {
        await page.getByRole('button', { name: '纯列表（表格）视图' }).click();
        await expect(page.getByRole('table')).toBeVisible();
      }
      await page.getByRole('button', { name: '网格视图', exact: true }).click();
      await page.locator('input[type="search"]').fill('布局');
      await page.locator('input[type="search"]').press('Enter');
      await expect(page).toHaveURL(/\/search\?/);
      await expect(page.getByText('找到 1 本书', { exact: true })).toBeVisible();
      await expectHeaderLayout(page);
    }
    await page.goto(`${APP_URL}/library`);
    await page.getByRole('button', { name: '在线', exact: true }).click();
    await expect(page.getByRole('heading', { name: '在线书库' })).toBeVisible();
    await expectHeaderLayout(page);
  });

  test(`continue card keeps a compact gap at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installLibraryLayoutMock(page);
    await page.goto(`${APP_URL}/shelf`);
    const card = page.getByRole('link', { name: `继续阅读《${LAYOUT_BOOK.title}》` });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('href', '/detail?id=42&continue=1');
    await expect(page.locator('.book-card-motion')).toBeVisible();
    const gap = await card.evaluate((element) => element.parentElement.nextElementSibling.firstElementChild.getBoundingClientRect().top - element.getBoundingClientRect().bottom);
    expect(gap).toBeCloseTo(viewport.width < 768 ? 12 : 16, 0);
    const history = page.getByRole('link', { name: '查看历史记录' });
    await history.focus();
    await expect(history).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/user\/history$/);
    await expect(page.getByRole('heading', { name: '历史记录', exact: true })).toBeVisible();
  });
}

test('offline and empty shelf keep the header and continue card compact', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installLibraryLayoutMock(page, { offlineMode: true });
  await page.goto(`${APP_URL}/shelf`);
  await expectHeaderLayout(page);
  await expect(page.getByRole('link', { name: '查看历史记录' })).toHaveCount(0);
  await expect(page.getByText('书架还是空的', { exact: true })).toBeVisible();
  const gap = await page.getByRole('link', { name: `继续阅读《${LAYOUT_BOOK.title}》` }).evaluate((element) => element.parentElement.nextElementSibling.firstElementChild.getBoundingClientRect().top - element.getBoundingClientRect().bottom);
  expect(gap).toBeCloseTo(12, 0);
});

test('shelf without a continue entry retains normal top padding', async ({ page }) => {
  await installLibraryLayoutMock(page, { continueReading: false });
  await page.goto(`${APP_URL}/shelf`);
  await expect(page.locator('.book-card-motion')).toBeVisible();
  await expect(page.getByRole('link', { name: /^继续阅读/ })).toHaveCount(0);
  await expectHeaderLayout(page);
});

test('a long shelf can scroll its final book above the mobile navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await installLibraryLayoutMock(page, { bookCount: 20 });
  await page.goto(`${APP_URL}/shelf`);
  const lastBook = page.locator('.book-card-motion').last();
  await expect(page.locator('.book-card-motion')).toHaveCount(20);
  await lastBook.scrollIntoViewIfNeeded();
  const box = await lastBook.boundingBox();
  const tabBar = await page.locator('.moke-tab-bar').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(tabBar.y);
});
