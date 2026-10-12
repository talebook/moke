import { test, expect } from '@playwright/test';

const base = process.env.MOKE_TAURI_TEST_BASE_URL;
test.skip(!base, 'Requires the Tauri frontend with synthetic IPC; this is not device evidence.');

for (const readerLabel of ['reader-1', 'moke-home-1']) {
  test(`open ${readerLabel} blocks connection before any server validation`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ readerLabel }) => {
      localStorage.setItem('moke-privacy-consent', '2026-08-14');
      localStorage.setItem('moke-server-storage', JSON.stringify({ version: 1, state: {
        savedServers: [{ id: 'a', url: 'https://a.example.test', title: 'A', addedAt: '' }],
      } }));
      const fixture = window.__connectionGuardFixture = { labels: ['main', readerLabel], httpCalls: [] };
      let nextCallback = 1;
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback() { return nextCallback++; }, unregisterCallback() {},
        async invoke(command) {
          if (command === 'moke_runtime_platform') return 'desktop';
          if (command === 'plugin:fs|exists') return false;
          if (command === 'plugin:window|get_all_windows') return [...fixture.labels];
          if (command.startsWith('plugin:http|')) {
            fixture.httpCalls.push(command);
            throw new Error('synthetic server offline');
          }
          if (command === 'plugin:event|listen') return nextCallback++;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:window|scale_factor') return 1;
          if (command === 'plugin:window|inner_size') return { width: 1280, height: 900 };
          throw new Error('Unsupported synthetic IPC command: ' + command);
        },
      };
    }, { readerLabel });
    await page.goto(base + '/welcome', { waitUntil: 'domcontentloaded' });
    const raw = await page.evaluate(() => localStorage.getItem('moke-server-storage'));
    await page.locator('li button').first().click();
    await expect(page.getByRole('alert').filter({ hasText: '请先关闭当前阅读器及阅读器书库窗口' })).toBeVisible();
    expect(await page.evaluate(() => window.__connectionGuardFixture.httpCalls)).toEqual([]);
    await expect(page).toHaveURL(/\/welcome$/);
    expect(await page.evaluate(() => localStorage.getItem('moke-server-storage'))).toBe(raw);
    await page.evaluate(() => { window.__connectionGuardFixture.labels = ['main']; });
    await page.locator('li button').first().click();
    await expect.poll(() => page.evaluate(() => window.__connectionGuardFixture.httpCalls.length)).toBeGreaterThan(0);
    await expect(page.locator('li button').first()).toBeEnabled();
    expect(errors).toEqual([]);
  });
}
