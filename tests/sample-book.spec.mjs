import { test, expect } from '@playwright/test';

const BASE_URL = process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke-developer-storage', JSON.stringify({
      state: { unlocked: true, enabled: true, showDebugPanel: false }, version: 0,
    }));
  });
});

function samplePanel(page) {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name: '示例书籍', exact: true }),
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`sample import persists and deletion restores the empty state at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${BASE_URL}/settings/developer`);
    const panel = samplePanel(page);
    const importButton = panel.getByRole('button', { name: '导入示例书籍' });
    await expect(importButton).toBeEnabled();
    expect(requests.filter((url) => url.includes('/samples/'))).toHaveLength(0);
    await importButton.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
    await page.reload();
    await expect(panel.getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
    expect(requests.filter((url) => url.includes('/samples/'))).toHaveLength(1);
    await panel.getByRole('button', { name: '在离线书库查看' }).click();
    await expect(page.getByText('墨客示例书', { exact: true })).toBeVisible();
    await page.goto(`${BASE_URL}/settings/developer`);
    await panel.getByRole('button', { name: '删除示例书籍' }).click();
    await expect(importButton).toBeEnabled();
    await page.goto(`${BASE_URL}/library`);
    await expect(page.getByText('墨客示例书', { exact: true })).toHaveCount(0);
    expect(requests.filter((url) => /\/api\/book\//.test(url))).toHaveLength(0);
  });
}

test('sample import disables repeated actions while loading and allows recovery from an error', async ({ page }) => {
  let releaseResponse;
  const responseReady = new Promise((resolve) => { releaseResponse = resolve; });
  await page.route('**/samples/moke-sample.epub', async (route) => {
    await responseReady;
    await route.fulfill({ status: 503, body: 'fixture unavailable' });
  });
  await page.goto(`${BASE_URL}/settings/developer`);
  const panel = samplePanel(page);
  await panel.getByRole('button', { name: '导入示例书籍' }).click();
  await expect(panel.getByRole('button', { name: '处理中…' })).toBeDisabled();
  releaseResponse();
  await expect(panel.getByRole('alert')).toHaveText('无法读取内置示例书籍，请重试。');
  await expect(panel.getByRole('button', { name: '导入示例书籍' })).toBeEnabled();
  await page.unroute('**/samples/moke-sample.epub');
  await panel.getByRole('button', { name: '导入示例书籍' }).click();
  await expect(panel.getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});
