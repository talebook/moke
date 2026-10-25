import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const base = process.env.MOKE_TEST_BASE_URL || 'http://127.0.0.1:3000';
const version = `v${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`;
const productionDebug = process.env.MOKE_TEST_PRODUCTION_DEBUG === '1';
const STORAGE_KEY = 'moke-developer-storage';
const VERSION_TAPS = 8;
const panelFor = (page) => page.getByRole('dialog', { name: '调试日志面板', exact: true });
const versionFor = (page) => page.getByRole('button', { name: version, exact: true });
const floatingFor = (page) => page.getByRole('button', { name: '调试日志', exact: true });
const readPreferences = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).state, STORAGE_KEY);

// The version number is the welcome page's hidden toggle for the floating
// debug button. Tapping a rapid series shows it, the next series hides it; the
// preference is persisted but nothing about the gesture is.
async function tapVersion(page) {
  for (let tap = 0; tap < VERSION_TAPS; tap += 1) await versionFor(page).click({ delay: 25 });
}

async function enterWelcome(page, preferences) {
  await page.addInitScript(({ key, preferences }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: preferences, version: 0 }));
  }, { key: STORAGE_KEY, preferences });
  await page.goto(base + '/welcome', { waitUntil: 'domcontentloaded' });
  // Accept through the real consent gate; never pre-seed its storage receipt.
  await expect(page.getByRole('button', { name: '同意并继续', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '同意并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接书库', exact: true })).toBeVisible();
  await expect(versionFor(page)).toBeVisible();
}

async function expectPanelClosed(page) {
  await expect(panelFor(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/welcome$/);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`version taps show and hide the floating logs button without a server ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const preferences = { unlocked: false, enabled: true, showDebugPanel: false };
    const serverRequests = [];
    const backgroundRoutes = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) serverRequests.push(request.url());
      if (path === '/shelf') backgroundRoutes.push(request.url());
    });
    await enterWelcome(page, preferences);
    await expect(floatingFor(page)).toHaveCount(0);

    await tapVersion(page);
    await expect(floatingFor(page)).toBeVisible();
    expect(await readPreferences(page)).toEqual({ ...preferences, showDebugPanel: true });

    await tapVersion(page);
    await expect(floatingFor(page)).toHaveCount(0);
    expect(await readPreferences(page)).toEqual(preferences);

    // The floating button opens the panel; closing it restores focus there.
    await tapVersion(page);
    await floatingFor(page).click();
    const panel = panelFor(page);
    await expect(panel).toBeVisible();
    const marker = `连接页浮动调试按钮日志 ${viewport.width}`;
    await page.evaluate((message) => console.info(message), marker);
    await expect(panel.getByText(marker, { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Console 日志/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^网络请求/ })).toBeVisible();
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await expectPanelClosed(page);
    await expect(floatingFor(page)).toBeFocused();

    await floatingFor(page).click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expectPanelClosed(page);
    await expect(floatingFor(page)).toBeFocused();

    for (const cancelable of [true, false]) {
      await floatingFor(page).click();
      await expect(panel).toBeVisible();
      const canceled = await page.evaluate((cancelable) =>
        !window.dispatchEvent(new CustomEvent('moke:native-back', { cancelable })), cancelable);
      expect(canceled).toBe(cancelable);
      await expectPanelClosed(page);
      await expect(floatingFor(page)).toBeFocused();
    }

    // With the panel closed, the next version series hides the floating button.
    await tapVersion(page);
    await expect(floatingFor(page)).toHaveCount(0);
    expect(await readPreferences(page)).toEqual(preferences);
    expect(backgroundRoutes).toEqual([]);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectPanelClosed(page);
    await expect(floatingFor(page)).toHaveCount(0);
    expect(await readPreferences(page)).toEqual(preferences);
    expect(serverRequests).toEqual([]);
  });

  test(`version taps persist the floating preference across reloads ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const preferences = { unlocked: true, enabled: false, showDebugPanel: true };
    await enterWelcome(page, preferences);
    await expect(floatingFor(page)).toBeVisible();
    await floatingFor(page).click();
    const panel = panelFor(page);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await expectPanelClosed(page);
    await expect(floatingFor(page)).toBeVisible();

    await tapVersion(page);
    await expect(floatingFor(page)).toHaveCount(0);
    expect(await readPreferences(page)).toEqual({ ...preferences, showDebugPanel: false });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectPanelClosed(page);
    await expect(floatingFor(page)).toHaveCount(0);

    await tapVersion(page);
    await expect(floatingFor(page)).toBeVisible();
    expect(await readPreferences(page)).toEqual(preferences);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectPanelClosed(page);
    await expect(floatingFor(page)).toBeVisible();
  });

  test(`production console capture follows the temporary drawer for a locked member ${viewport.width}`, async ({ page }) => {
    test.skip(!productionDebug, 'Requires a production server and MOKE_TEST_PRODUCTION_DEBUG=1; development always captures console.');
    await page.setViewportSize(viewport);
    const preferences = { unlocked: false, enabled: true, showDebugPanel: false };
    await enterWelcome(page, preferences);
    const messages = () => page.evaluate(() => JSON.parse(localStorage.getItem('moke-debug-logs-v1') || '[]').map((entry) => entry.message));
    const before = `production 默认未捕获 ${viewport.width}`;
    await page.evaluate((message) => console.info(message), before);
    expect(await messages()).not.toContain(before);

    await tapVersion(page);
    await floatingFor(page).click();
    const panel = panelFor(page);
    await expect(panel).toBeVisible();
    const during = `production 面板打开时捕获 ${viewport.width}`;
    await page.evaluate((message) => console.info(message), during);
    await expect(panel.getByText(during, { exact: true })).toBeVisible();
    expect(await messages()).toContain(during);
    expect(await readPreferences(page)).toEqual({ ...preferences, showDebugPanel: true });

    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await expectPanelClosed(page);
    const after = `production 面板关闭后未捕获 ${viewport.width}`;
    await page.evaluate((message) => console.info(message), after);
    expect(await messages()).not.toContain(after);
    await floatingFor(page).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(during, { exact: true })).toBeVisible();
    await expect(panel.getByText(before, { exact: true })).toHaveCount(0);
    await expect(panel.getByText(after, { exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await expectPanelClosed(page);
  });
}
