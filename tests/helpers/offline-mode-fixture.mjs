import { expect } from '@playwright/test';

/** Seed only the durable v1 list. Connection, user, capabilities and mode come from the UI. */
export async function installSavedServerFixture(page, serverUrl, title = 'Moke 测试书库') {
  await page.addInitScript(({ serverUrl, title }) => {
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    if (!localStorage.getItem('moke-server-storage')) {
      localStorage.setItem('moke-server-storage', JSON.stringify({
        version: 1,
        state: { savedServers: [{ id: 'fixture-server', url: serverUrl, title, addedAt: '2026-10-11T00:00:00Z' }] },
      }));
    }
  }, { serverUrl, title });
}

export async function connectSavedServerFixture(page, baseUrl, serverUrl) {
  await page.goto(`${baseUrl}/welcome`, { waitUntil: 'domcontentloaded' });
  await page.locator('li button').filter({ hasText: serverUrl }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible();
}

export async function clickAppLink(page, path) {
  // Sidebar and tab bar share hrefs; choose the one actually displayed at this viewport.
  await page.locator(`a[href="${path}"]:visible`).first().click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

export async function openFixtureBookDetail(page, bookId = '42') {
  await page.locator(`a[href="/detail?id=${bookId}"]:visible`).first().click();
  await expect(page).toHaveURL(new RegExp(`/detail\\?id=${bookId}$`));
}

export async function enterOfflineModeFromSettings(page) {
  await clickAppLink(page, '/settings');
  // Requests from the connected setup are expected. Keep the same document and
  // start the offline checkpoint immediately before the real disconnect action.
  await page.evaluate(() => { window.__MOKE_TEST_HTTP_REQUESTS__.length = 0; });
  await page.getByRole('button', { name: /^进入离线模式/ }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  await expect(page.getByRole('link', { name: '查看历史记录', exact: true })).toHaveCount(0);
}

export async function enterOfflineModeFromWelcome(page, baseUrl) {
  await page.goto(`${baseUrl}/welcome`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
}

export async function openOfflineFixtureBookDetail(page, bookId = '42') {
  // Downloads without inShelf still appear in the real offline library.
  await clickAppLink(page, '/library');
  await openFixtureBookDetail(page, bookId);
}
