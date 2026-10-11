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

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 640, height: 480 }]) {
  test(`sample import persists and deletion restores the empty state at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${BASE_URL}/settings/developer`, { waitUntil: 'domcontentloaded' });
    const panel = samplePanel(page);
    const importButton = panel.getByRole('button', { name: '导入示例书籍' });
    await expect(importButton).toBeEnabled();
    expect(requests.filter((url) => url.includes('/samples/'))).toHaveLength(0);
    await importButton.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel.getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
    expect(requests.filter((url) => url.includes('/samples/'))).toHaveLength(1);
    await panel.getByRole('button', { name: '在离线书库查看' }).click();
    await expect(page.getByText('墨客示例书', { exact: true })).toBeVisible();
    await page.goto(`${BASE_URL}/settings/developer`, { waitUntil: 'domcontentloaded' });
    await panel.getByRole('button', { name: '删除示例书籍' }).click();
    await expect(importButton).toBeEnabled();
    await page.goto(`${BASE_URL}/library`, { waitUntil: 'domcontentloaded' });
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
  await page.goto(`${BASE_URL}/settings/developer`, { waitUntil: 'domcontentloaded' });
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

for (const delayedWindow of ['first', 'second']) {
  test(`confirmed deletion fences a delayed import in the ${delayedWindow} window`, async ({ page, context }) => {
    const other = await context.newPage();
    const delayed = delayedWindow === 'first' ? page : other;
    const deleting = delayedWindow === 'first' ? other : page;
    await Promise.all([page, other].map((tab) => tab.goto(`${BASE_URL}/settings/developer`, { waitUntil: 'domcontentloaded' })));
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const requested = new Promise((resolve) => { started = resolve; });
    await delayed.route('**/samples/moke-sample.epub', async (route) => {
      started();
      await gate;
      await route.continue();
    });
    await samplePanel(delayed).getByRole('button', { name: '导入示例书籍' }).click();
    await requested;
    await expect(samplePanel(delayed).getByRole('button', { name: '处理中…' })).toBeDisabled();
    await samplePanel(deleting).getByRole('button', { name: '导入示例书籍' }).click();
    await samplePanel(deleting).getByRole('button', { name: '删除示例书籍' }).click();
    await expect(samplePanel(deleting).getByRole('button', { name: '导入示例书籍' })).toBeEnabled();
    release();
    await expect(samplePanel(delayed).getByRole('alert')).toHaveText('示例书籍已在另一窗口删除，请重新导入。');
    await deleting.reload({ waitUntil: 'domcontentloaded' });
    await expect(samplePanel(deleting).getByRole('button', { name: '导入示例书籍' })).toBeEnabled();
    await delayed.unroute('**/samples/moke-sample.epub');
    await samplePanel(delayed).getByRole('button', { name: '导入示例书籍' }).click();
    await expect(samplePanel(delayed).getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
    await deleting.reload({ waitUntil: 'domcontentloaded' });
    await expect(samplePanel(deleting).getByRole('button', { name: '删除示例书籍' })).toBeEnabled();
    await other.close();
  });
}

test('640x480 shelf context menu can remove the sample book', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(`${BASE_URL}/settings/developer`, { waitUntil: 'domcontentloaded' });
  const panel = samplePanel(page);
  await panel.getByRole('button', { name: '导入示例书籍' }).click();
  await panel.getByRole('button', { name: '在离线书库查看' }).click();
  await page.goto(`${BASE_URL}/shelf`, { waitUntil: 'domcontentloaded' });
  const book = page.getByRole('link').filter({ has: page.getByText('墨客示例书', { exact: true }) });
  await expect(book).toBeVisible();
  await book.scrollIntoViewIfNeeded();
  // The menu intentionally closes on scroll. Drain the card's automatic
  // scroll/layout events before opening it, as a settled user interaction does.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await book.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移出书架' }).click();
  await expect(page.getByText('墨客示例书', { exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('墨客示例书', { exact: true })).toHaveCount(0);
});
