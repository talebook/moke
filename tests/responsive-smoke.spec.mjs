import { test, expect } from '@playwright/test';

const states = [
  { name: 'mobile', width: 390, height: 844, tabBarVisible: true, sidebarVisible: false },
  { name: 'tablet', width: 768, height: 1024, tabBarVisible: true, sidebarVisible: false },
  { name: 'desktop', width: 1280, height: 900, tabBarVisible: false, sidebarVisible: true },
];

test('低高度屏幕上的隐私确认保持极简可操作', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto('http://127.0.0.1:3000/settings/developer', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('button', { name: '查看隐私政策' })).toBeVisible();
  await expect(page.getByRole('button', { name: '同意并继续' })).toBeVisible();
  await expect(page.getByRole('button', { name: '拒绝并退出' })).toBeVisible();
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
