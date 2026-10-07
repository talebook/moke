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
      const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state);
      expect(pending.user).toBeNull();
      expect(pending.capabilities.checkedAt).toBeNull();
      expect(pending.capabilities.annotationApiStatus).toBe('unchecked');
      await expect(page.getByRole('button', { name: '登录中...' })).toBeDisabled();
      if (releaseBeforeConfirmation) {
        await page.evaluate(() => window.releaseAnonymousUser());
        await expect.poll(() => page.evaluate(() => window.loginRace.anonymousCompleted)).toBe(1);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.user)).toBeNull();
      }
      await page.evaluate(() => window.releaseConfirmedUser());
      await expect(page).toHaveURL(/\/shelf$/);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.user?.id)).toBe(7);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state.capabilities.checkedAt)).not.toBeNull();
      const confirmed = await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')).state);
      if (!releaseBeforeConfirmation) {
        await page.evaluate(() => window.releaseAnonymousUser());
        await expect.poll(() => page.evaluate(() => window.loginRace.anonymousCompleted)).toBe(1);
      }
      // A further authenticated navigation observes the final state after the
      // old request's provider and promise cleanup have had a chance to run.
      await page.getByRole('link', { name: '书库', exact: true }).first().click();
      await expect(page.getByRole('heading', { name: '全部藏书', exact: true })).toBeVisible();
      const final = await page.evaluate(() => ({ state: JSON.parse(localStorage.getItem('moke-server-storage')).state, trace: window.loginRace }));
      expect(final.state.user.id).toBe(7);
      expect(final.state.sessionRevision).toBe(confirmed.sessionRevision);
      expect(final.state.serverTitle).toBe('登录回归书库');
      expect(final.trace.signIns).toBe(1);
      await expect(page.getByText('登录请求已成功，但服务器没有建立登录状态。', { exact: false })).toHaveCount(0);
    });
  }
}
