import { test, expect } from '@playwright/test';

const states = [
  { name: 'mobile', width: 390, height: 844, tabBarVisible: true, sidebarVisible: false },
  { name: 'tablet', width: 768, height: 1024, tabBarVisible: true, sidebarVisible: false },
  { name: 'desktop', width: 1280, height: 900, tabBarVisible: false, sidebarVisible: true },
];

async function expectInViewport(locator, viewport) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();

  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test('低高度屏幕上的隐私确认可滚动到所有信息与操作', async ({ page }) => {
  const viewports = [
    { width: 390, height: 480 },
    { width: 390, height: 320 },
  ];

  for (const viewport of viewports) {
    await test.step(`${viewport.width}x${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      await page.goto('http://127.0.0.1:3000/settings/developer', {
        waitUntil: 'domcontentloaded',
      });

      const dialog = page.getByRole('dialog');
      const title = page.getByRole('heading', { name: '隐私政策提示' });
      const policyButton = page.getByRole('button', { name: '查看隐私政策' });
      const acceptButton = page.getByRole('button', { name: '同意并继续' });
      const declineButton = page.getByRole('button', { name: '拒绝并退出' });

      // Visit the bottom first, then prove the top is still reachable. This
      // catches centered overflow whose negative top cannot be scrolled back.
      await expectInViewport(declineButton, viewport);
      await expectInViewport(title, viewport);
      await expectInViewport(policyButton, viewport);
      await policyButton.click();
      await expect(page).toHaveURL(/\/privacy$/);

      await page.goBack({ waitUntil: 'domcontentloaded' });
      await expect(dialog).toBeVisible();
      await expectInViewport(acceptButton, viewport);
      await expectInViewport(declineButton, viewport);
      await declineButton.click();
      await expect(page.getByRole('button', { name: '重新选择' })).toBeVisible();

      await page.getByRole('button', { name: '重新选择' }).click();
      await acceptButton.click();
      await expect(dialog).toBeHidden();

      await page.evaluate(() => localStorage.removeItem('moke-privacy-consent'));
    });
  }
});

test('常规高度的隐私确认居中且不产生滚动', async ({ page }) => {
  const viewports = [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ];

  for (const viewport of viewports) {
    await test.step(`${viewport.width}x${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      await page.goto('http://127.0.0.1:3000/settings/developer', {
        waitUntil: 'domcontentloaded',
      });

      const layout = await page.getByRole('dialog').evaluate((dialog) => {
        const scrollContainer = dialog.parentElement;
        const box = dialog.getBoundingClientRect();
        if (!scrollContainer) throw new Error('Privacy dialog has no scroll container');

        return {
          centerX: box.left + box.width / 2,
          centerY: box.top + box.height / 2,
          clientHeight: scrollContainer.clientHeight,
          scrollHeight: scrollContainer.scrollHeight,
        };
      });

      expect(Math.abs(layout.centerX - viewport.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.centerY - viewport.height / 2)).toBeLessThanOrEqual(1);
      expect(layout.scrollHeight).toBe(layout.clientHeight);

      await page.evaluate(() => localStorage.removeItem('moke-privacy-consent'));
    });
  }
});

test('responsive navigation remains usable across device sizes', async ({ page }, testInfo) => {
  await page.goto('http://127.0.0.1:3000/settings/developer', { waitUntil: 'domcontentloaded' });

  // First launch is intentionally blocked by the privacy consent gate. Verify
  // that the prompt appears, then explicitly accept before testing app chrome.
  const consentButton = page.getByRole('button', { name: '同意并继续' });
  await expect(consentButton).toBeVisible();
  await consentButton.click();

  for (const state of states) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('.app-warm-bg')).toBeVisible();
    if (state.tabBarVisible) {
      await expect(page.locator('.moke-tab-bar')).toBeVisible();
    } else {
      await expect(page.locator('.moke-tab-bar')).toBeHidden();
    }
    if (state.sidebarVisible) {
      await expect(page.locator('.moke-sidebar')).toBeVisible();
    } else {
      await expect(page.locator('.moke-sidebar')).toBeHidden();
    }

    await page.screenshot({
      path: testInfo.outputPath(`responsive-${state.name}.png`),
      fullPage: true,
    });
  }
});

test('privacy consent can be revoked from the policy page', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/settings/developer', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '同意并继续' }).click();

  await page.goto('http://127.0.0.1:3000/privacy', { waitUntil: 'domcontentloaded' });
  const revokeButton = page.getByRole('button', { name: '撤回同意' });
  await expect(revokeButton).toBeVisible();
  await revokeButton.click();

  await expect(page.getByRole('heading', { name: '隐私政策提示' })).toBeVisible();
  await expect(page.getByRole('button', { name: '同意并继续' })).toBeVisible();
});
