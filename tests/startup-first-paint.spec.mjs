import { test, expect as baseExpect } from '@playwright/test';
import { installFirstPaintMock } from './helpers/startup-first-paint.mjs';

const expect = baseExpect.configure({ timeout: 15_000 });
const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const backgrounds = { light: 'rgb(251, 250, 243)', dark: 'rgb(26, 24, 20)', eink: 'rgb(255, 255, 255)' };

for (const runtime of ['android', 'ios', 'linux']) {
  for (const appearance of ['light', 'dark', 'eink']) {
    test(`${runtime} ${appearance} startup keeps its center through late safe area and font load`, async ({ page }) => {
      await page.setViewportSize(runtime === 'linux' ? { width: 1280, height: 900 } : { width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'light' : 'dark' });
      await installFirstPaintMock(page, { runtime, appearance });
      const fontWaiters = [];
      let fontsReleased = false;
      await page.route('**/*.woff2', async (route) => {
        if (!fontsReleased) await new Promise((resolve) => fontWaiters.push(resolve));
        await route.continue();
      });
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.firstPaintGate?.authPending);
      if (runtime !== 'linux') await page.waitForFunction(() => window.firstPaintGate.insetPending);
      await expect(page.getByTestId('app-startup-screen')).toHaveCount(1);
      await expect.poll(() => fontWaiters.length).toBeGreaterThan(0);
      const before = await page.evaluate(() => window.firstPaintFrames[0]);
      expect(before.background).toBe(backgrounds[appearance]);
      await page.evaluate(() => window.firstPaintGate.releaseInset());
      if (runtime !== 'linux') {
        await page.waitForFunction((top) => document.documentElement.style.getPropertyValue('--moke-top-safe-area') === `${top}px`, runtime === 'ios' ? 44 : 48);
      }
      fontsReleased = true;
      fontWaiters.splice(0).forEach((resolve) => resolve());
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const frames = await page.evaluate(() => window.firstPaintFrames);
      for (const frame of frames) {
        expect(frame.x).toBeCloseTo(before.x, 1);
        expect(frame.y).toBeCloseTo(before.y, 1);
        expect(frame.width).toBe(32);
        expect(frame.height).toBe(32);
        expect(frame.padding).toBe('0px');
        expect(frame.background).toBe(backgrounds[appearance]);
      }
      await page.evaluate(() => window.firstPaintGate.releaseAuth());
      await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible();
      // The startup exception must keep normal content below the status bar.
      if (runtime !== 'linux') {
        const padding = await page.locator('.moke-app-root > :first-child').evaluate((el) => getComputedStyle(el).paddingTop);
        expect(padding).toBe(`${runtime === 'ios' ? 44 : 48}px`);
      }
    });
  }
}
