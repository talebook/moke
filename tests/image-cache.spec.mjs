import { test, expect } from '@playwright/test';
import { installCoverQueueMock } from './helpers/image-cache.mjs';
import { openLayoutRoute } from './helpers/library-layout.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
test.setTimeout(60_000);

async function expectDecodedCovers(page) {
  const images = page.locator('img.book-cover-media[src^="blob:"]');
  await expect(images).toHaveCount(6);
  const decoded = await images.evaluateAll((elements) => Promise.all(elements.map(async (img) => {
    await img.decode(); // Reject broken images, even if they have blob URLs.
    return { width: img.naturalWidth, height: img.naturalHeight };
  })));
  for (const image of decoded) {
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
  }
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const legacySignal of [false, true]) {
    test(`abandoned covers release the queue on navigation at ${viewport.width}px (legacy signal: ${legacySignal})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installCoverQueueMock(page);
      if (legacySignal) await page.addInitScript(() => {
        Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined });
      });
      await openLayoutRoute(page, APP_URL, '/shelf');
      await expect.poll(() => page.evaluate(() => window.coverQueue.started.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(6);
      await page.getByRole('link', { name: '书库', exact: true }).first().click();
      await expect(page.getByRole('heading', { name: '全部藏书', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.coverQueue.started.filter((url) => url.includes('/new-')).length)).toBe(6);
      await expectDecodedCovers(page);
      // Account confirmation can start a second old-cover generation; both must
      // have been cancelled before the new page's covers can load.
      const oldUrls = await page.evaluate(() => window.coverQueue.started.filter((url) => url.includes('/old-')));
      const oldCount = oldUrls.length;
      expect(await page.evaluate(() => window.coverQueue.cancelled.length)).toBe(oldCount);
      expect(await page.evaluate(() => [...window.coverQueue.cancelled].sort())).toEqual([...oldUrls].sort());
      const freshSources = await page.locator('img.book-cover-media[src^="blob:"]').evaluateAll(images => images.map(img => img.src));
      await page.evaluate(() => window.releaseOldCovers());
      await expect.poll(() => page.evaluate(() => window.coverQueue.bodyCancelled.length)).toBe(oldCount);
      expect(await page.evaluate(() => [...window.coverQueue.bodyCancelledUrls].sort())).toEqual([...oldUrls].sort());
      await expectDecodedCovers(page);
      expect(await page.locator('img.book-cover-media[src^="blob:"]').evaluateAll(images => images.map(img => img.src))).toEqual(freshSources);
    });
  }
}
