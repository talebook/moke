import { test, expect } from '@playwright/test';
import { installLoginRaceMock, openLoginWithAnonymousRequest } from './helpers/login-race.mjs';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
test.setTimeout(60_000);

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const releaseBeforeConfirmation of [false, true]) {
    test(`login isolates the old guest response ${releaseBeforeConfirmation ? 'during' : 'after'} confirmation at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installLoginRaceMock(page, { holdConfirmation: true });
      await openLoginWithAnonymousRequest(page, APP_URL);
      await expect.poll(() => page.evaluate(() => window.loginRace.infoStarted.filter((kind) => kind === 'confirmed').length)).toBe(1);
      // Runtime accounts and capabilities are intentionally absent from the
      // saved registry. Observe confirmation and the real rendered account.
      expect(await page.evaluate(() => window.loginRace.infoCompleted.filter(info => info.authenticated).length)).toBe(0);
      expect(await page.evaluate(() => window.loginRace.signIns)).toBe(1);
      // Mobile visits the personal panel before login and may start another
      // provider round. Every old guest request must complete after release.
      const anonymousRequests = await page.evaluate(() => window.loginRace.infoStarted.filter(kind => kind === 'anonymous').length);
      expect(anonymousRequests).toBeGreaterThanOrEqual(1);
      await expect(page.getByRole('button', { name: '登录中...' })).toBeDisabled();
      if (releaseBeforeConfirmation) {
        await page.evaluate(() => window.releaseAnonymousUser());
        await expect.poll(() => page.evaluate(() => window.loginRace.anonymousCompleted)).toBe(anonymousRequests);
        expect(await page.evaluate(() => window.loginRace.infoCompleted.filter(info => info.authenticated).length)).toBe(0);
        await expect(page.getByRole('button', { name: '登录中...' })).toBeDisabled();
      }
      await page.evaluate(() => window.releaseConfirmedUser());
      await expect(page).toHaveURL(/\/shelf$/);
      await expect(page.locator('.moke-sidebar a[href="/user"]')).toContainText('回归读者');
      await expect(page.locator('.moke-sidebar [title="登录回归书库"]')).toHaveCount(1);
      await expect.poll(() => page.evaluate(() => window.loginRace.infoCompleted.filter(info => info.authenticated && info.userId === 7).length)).toBeGreaterThanOrEqual(1);
      const confirmedRequests = await page.evaluate(() => window.loginRace.infoStarted.filter(kind => kind === 'confirmed').length);
      if (!releaseBeforeConfirmation) {
        await page.evaluate(() => window.releaseAnonymousUser());
        await expect.poll(() => page.evaluate(() => window.loginRace.anonymousCompleted)).toBe(anonymousRequests);
      }
      // A further authenticated navigation observes the final state after the
      // old request's provider and promise cleanup have had a chance to run.
      await page.getByRole('link', { name: '书库', exact: true }).first().click();
      await expect(page.getByRole('heading', { name: '全部藏书', exact: true })).toBeVisible();
      // Sidebar subscribes to the production account/title, including when
      // hidden on mobile. A late guest must not turn it back into a login link.
      await expect(page.locator('.moke-sidebar a[href="/user"]')).toContainText('回归读者');
      await expect(page.locator('.moke-sidebar a[href="/login"]')).toHaveCount(0);
      await expect(page.locator('.moke-sidebar [title="登录回归书库"]')).toHaveCount(1);
      // A stale guest must not invalidate the confirmed account/capability
      // session and trigger another provider confirmation on this navigation.
      expect(await page.evaluate(() => window.loginRace.infoStarted.filter(kind => kind === 'confirmed').length)).toBe(confirmedRequests);
      if (viewport.width < 1024) {
        await page.getByRole('link', { name: '我的', exact: true }).click();
      } else {
        await page.locator('.moke-sidebar a[href="/user"]').click();
      }
      await expect(page.getByRole('heading', { name: '回归读者', exact: true })).toBeVisible();
      await expect(page.getByText('@race-reader', { exact: true })).toBeVisible();
      const final = await page.evaluate(() => window.loginRace);
      expect(final.validationInfo).toEqual([{ authenticated: false, userId: null }]);
      expect(final.profileReads.at(-1)).toEqual({ authenticated: true, userId: 7 });
      expect(final.signIns).toBe(1);
      expect(final.anonymousCompleted).toBe(anonymousRequests);
      expect(final.infoCompleted.some(info => !info.authenticated && info.userId === null)).toBe(true);
      await expect(page.getByText('登录请求已成功，但服务器没有建立登录状态。', { exact: false })).toHaveCount(0);
    });
  }
}
