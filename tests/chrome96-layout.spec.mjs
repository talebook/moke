import { test, expect } from '@playwright/test';
import { installLibraryLayoutMock } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

// Capability restriction in a modern engine; real Chrome 96 remains a separate
// acceptance run. Dropping unsupported declarations preserves the vh fallback.
async function removeDynamicViewportUnits(page) {
  await page.evaluate(() => {
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.style) {
          for (const property of [...rule.style]) {
            if (/[ds]vh/.test(rule.style.getPropertyValue(property))) {
              rule.style.removeProperty(property);
            }
          }
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 480 }]) {
  test(`settings scroll within the viewport without dvh at ${viewport.width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem('moke-privacy-consent', '2026-08-14');
      localStorage.setItem('moke-server-storage', JSON.stringify({
        state: { serverUrl: '', offlineMode: true }, version: 0,
      }));
    });
    await page.goto(`${APP_URL}/settings`);
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await removeDynamicViewportUnits(page);
    const content = page.locator('.moke-route-content');
    expect((await content.boundingBox()).height).toBe(viewport.height);
    const scrolling = content.locator(':scope > .overflow-y-auto');
    const layout = await scrolling.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop,
        rootScroll: document.documentElement.scrollHeight, height: innerHeight };
    });
    expect(layout.scroll).toBeGreaterThan(layout.client);
    expect(layout.top).toBeGreaterThan(0);
    expect(layout.rootScroll).toBeLessThanOrEqual(layout.height);
    await scrolling.evaluate((el) => { el.scrollTop = 0; });
    await page.getByRole('link', { name: /隐私政策/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/privacy$/);
    await removeDynamicViewportUnits(page);
    await page.getByRole('button', { name: '撤回同意' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '撤回同意' }).click();
    await expect(page.getByRole('heading', { name: '隐私政策提示' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`all tags stay scrollable without dvh at ${viewport.width}px`, async ({ page }) => {
    // Retain coverage for an already-open dialog when the viewport shrinks.
    const openingViewport = { ...viewport, height: Math.max(viewport.height, 844) };
    await page.setViewportSize(openingViewport);
    await installLibraryLayoutMock(page, { continueReading: false,
      navs: [{ tags: Array.from({ length: 80 }, (_, index) => ({
        name: `标签${index + 1}`,
      })) }],
    });
    await page.goto(`${APP_URL}/library`);
    const trigger = page.getByText('标签', { exact: true }).locator('..').getByRole('button');
    await trigger.click();
    await page.getByRole('option', { name: '更多标签…' }).click();
    const dialog = page.getByRole('dialog', { name: '全部标签' });
    await expect(dialog).toBeVisible();
    await page.setViewportSize(viewport);
    await removeDynamicViewportUnits(page);
    expect((await dialog.boundingBox()).height).toBeLessThanOrEqual(viewport.height * 0.85);
    const last = dialog.getByRole('button', { name: '标签80', exact: true });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveText('标签80');
    await page.setViewportSize(openingViewport);
    await trigger.click();
    await page.getByRole('option', { name: '更多标签…' }).click();
    await expect(dialog).toBeVisible();
    await page.setViewportSize(viewport);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}

for (const viewport of [
  { width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 480 },
]) {
  test(`all tags are reachable from the initial ${viewport.width}x${viewport.height} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installLibraryLayoutMock(page, { continueReading: false,
      navs: [{ tags: Array.from({ length: 80 }, (_, index) => ({ name: `标签${index + 1}` })) }],
    });
    await page.goto(`${APP_URL}/library`);
    const trigger = page.getByText('标签', { exact: true }).locator('..').getByRole('button');
    await trigger.click();
    const panel = page.getByRole('listbox');
    const bounds = await panel.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 8);
    await panel.hover();
    await page.mouse.wheel(0, 1000);
    await page.getByRole('option', { name: '更多标签…' }).click();
    const dialog = page.getByRole('dialog', { name: '全部标签' });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole('button', { name: '关闭全部标签' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '标签80', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await dialog.getByRole('button', { name: '标签80', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveText('标签80');
    await expect(trigger).toBeFocused();
    // Native keyboard activation must also reach the same entry at this size.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const more = page.getByRole('option', { name: '更多标签…' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test('an open tag selector stays inside the viewport and flips to the roomier side on resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installLibraryLayoutMock(page, { continueReading: false,
    navs: [{ tags: Array.from({ length: 80 }, (_, index) => ({ name: `标签${index + 1}` })) }],
  });
  await page.goto(`${APP_URL}/library`);
  const trigger = page.getByText('标签', { exact: true }).locator('..').getByRole('button');
  await trigger.click();
  for (const height of [480, 400, 844]) {
    await page.setViewportSize({ width: 390, height });
    await expect.poll(async () => {
      const bounds = await page.getByRole('listbox').boundingBox();
      return bounds.y >= 8 && bounds.y + bounds.height <= height - 8;
    }).toBe(true);
    if (height === 400) {
      const panel = await page.getByRole('listbox').boundingBox();
      const button = await trigger.boundingBox();
      expect(panel.y + panel.height).toBeLessThan(button.y);
    }
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
});
