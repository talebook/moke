import { test, expect } from '@playwright/test';
import { installLibraryLayoutMock } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const backgrounds = {
  light: 'rgb(251, 250, 243)', dark: 'rgb(26, 24, 20)', eink: 'rgb(255, 255, 255)',
};

for (const appearance of ['light', 'dark', 'eink']) {
  test(`${appearance} startup stays centered when the native top inset arrives`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'light' : 'dark' });
    await installLibraryLayoutMock(page, {
      nativeRuntime: 'android', theme: appearance === 'dark' ? 'dark' : 'light',
      eink: appearance === 'eink',
    });
    await page.addInitScript(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let release;
      const inset = new Promise((resolve) => { release = resolve; });
      window.releaseStartupInset = release;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'plugin:native-bridge|get_status_bar_height') {
          await inset;
          return { height: 48 * window.devicePixelRatio };
        }
        // Hold the native route change while measuring the existing startup UI.
        if (command === 'moke_navigate') return new Promise(() => {});
        return invoke(command, args);
      };
    });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const screen = page.locator('.moke-startup-screen');
    await expect(screen).toBeVisible();
    const measure = () => screen.evaluate((element) => {
      const spinner = element.firstElementChild;
      const rect = spinner.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        width: spinner.offsetWidth, height: spinner.offsetHeight,
        padding: getComputedStyle(element).paddingTop,
        background: getComputedStyle(document.documentElement).backgroundColor,
      };
    });
    const before = await measure();
    expect(before.background).toBe(backgrounds[appearance]);
    await page.evaluate(() => window.releaseStartupInset());
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--moke-top-safe-area'))).toBe('48px');
    const after = await measure();
    expect(after).toEqual(before);
    expect(after.x).toBe(195);
    expect(after.y).toBe(422);
    expect(after.width).toBe(32);
    expect(after.height).toBe(32);
    expect(after.padding).toBe('0px');
  });
}
