import { test, expect } from '@playwright/test';
import { installLibraryLayoutMock } from './helpers/library-layout.mjs';

test.setTimeout(60_000);

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const viewports = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 767, height: 1024 },
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
      searchGroup: rect(header.querySelector('input[type="search"]').parentElement.parentElement),
      history: history ? rect(history) : null,
      contentRight: header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(layout.toggle.x).toBeGreaterThan(layout.title.right);
  expect(layout.toggle.y).toBeLessThan(layout.title.bottom);
  expect(layout.toggle.bottom).toBeGreaterThan(layout.title.y);
  expect(layout.toggle.right).toBeCloseTo(layout.contentRight, 0);
  expect(layout.overflow).toBe(false);
  if (page.viewportSize().width < 768) {
    expect(layout.search.y).toBeGreaterThan(layout.title.bottom);
    expect(layout.toggle.bottom).toBeLessThan(layout.search.y);
  } else {
    expect(layout.search.x).toBeGreaterThan(layout.title.right);
    expect(layout.searchGroup.right).toBeLessThan(layout.history?.x ?? layout.toggle.x);
    expect(layout.search.y).toBeLessThan(layout.title.bottom);
    expect(layout.search.bottom).toBeGreaterThan(layout.title.y);
    expect(layout.search.y).toBeLessThan(layout.toggle.bottom);
    expect(layout.search.bottom).toBeGreaterThan(layout.toggle.y);
  }
  if (layout.history) {
    expect(layout.history.x).toBeGreaterThan(layout.title.right);
    if (page.viewportSize().width < 768) {
      expect(layout.history.bottom).toBeLessThan(layout.search.y);
    } else {
      expect(layout.search.y).toBeLessThan(layout.history.bottom);
      expect(layout.search.bottom).toBeGreaterThan(layout.history.y);
    }
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

}

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


test('table mode mounts a single representation when resizing across md', async ({ page }) => {
  await installLibraryLayoutMock(page, { bookCount: 3 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP_URL}/shelf`);
  await page.getByRole('button', { name: '纯列表（表格）视图' }).click();
  for (const width of [1280, 390, 768, 767, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('table')).toHaveCount(width < 768 ? 0 : 1);
    await expect(page.getByRole('link', { name: /测试书籍 3/ })).toHaveCount(1);
  }
});
