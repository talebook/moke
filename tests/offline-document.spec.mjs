import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const base = process.env.MOKE_TAURI_TEST_BASE_URL;
test.skip(!base, 'Requires the Tauri frontend served with synthetic native IPC; this is not device evidence.');

for (const [platform, denied] of [['ios', false], ['android', false], ['ohos', false], ['ios', true]]) {
  test(`sample offline document entry for simulated ${platform}${denied ? ' with denied session storage' : ''}`, async ({ page }, testInfo) => {
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(({ runtime, denied }) => {
      if (denied) {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'moke-reader-return-v1') throw new DOMException('denied', 'SecurityError');
          return write.call(this, key, value);
        };
      }
      localStorage.setItem('moke-privacy-consent', '2026-08-14');
      localStorage.setItem('moke-developer-storage', JSON.stringify({ version: 0, state: { unlocked: true, enabled: true } }));
      localStorage.setItem('moke-server-storage', JSON.stringify({ version: 1, state: { savedServers: [] } }));
      sessionStorage.setItem('fixture-document-count', String(Number(sessionStorage.getItem('fixture-document-count') || 0) + 1));
      const book = {
        id: 'moke-sample://bundled::moke-bundled-sample-v1::epub', serverUrl: 'moke-sample://bundled',
        bookId: 'moke-bundled-sample-v1', title: '墨客示例书', author: '墨客', inShelf: true,
        fileName: 'moke-sample.epub', filePath: '/fixture/books/moke-sample.epub',
        mimeType: 'application/epub+zip', fileSize: 1234, updatedAt: 1,
      };
      const callbacks = new Map(); let nextCallback = 1;
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        convertFileSrc: () => '/samples/moke-sample.epub',
        async invoke(command, args) {
          if (command === 'moke_runtime_platform') return runtime;
          if (command === 'moke_list_downloaded_books') return [book];
          if (command === 'moke_navigate') { window.location.assign(args.path); return null; }
          if (command === 'plugin:fs|exists') return false;
          if (command === 'plugin:window|get_all_windows') return ['main'];
          if (command === 'plugin:event|listen') return nextCallback++;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:window|scale_factor') return 1;
          if (command === 'plugin:window|inner_size') return { width: 390, height: 844 };
          if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0, bottom: 0 };
          if (command === 'plugin:native-bridge|get_status_bar_height') return { height: 0 };
          if (command === 'plugin:native-bridge|set_system_ui_visibility') return { success: true };
          if (command === 'moke_get_download_directory') return null;
          throw new Error('Unsupported synthetic IPC command: ' + command);
        },
      };
    }, { runtime: platform, denied });
    await page.goto(base + '/settings/developer', { waitUntil: 'domcontentloaded' });
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: '示例书籍', exact: true }) });
    await expect(panel.getByRole('button', { name: /删除示例书籍/ })).toBeEnabled();
    const before = await page.evaluate(() => Number(sessionStorage.getItem('fixture-document-count')));
    await panel.getByRole('button', { name: '在离线书库查看', exact: true }).click();
    if (denied) {
      await expect(panel.getByRole('alert')).toHaveText(/无法保存离线书库跳转信息.*存储权限/);
      await expect(page).toHaveURL(/\/settings\/developer$/);
      expect(await page.evaluate(() => Number(sessionStorage.getItem('fixture-document-count')))).toBe(before);
      await expect(panel.getByRole('button', { name: '在离线书库查看', exact: true })).toBeEnabled();
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('offline-ios-denied.png'), fullPage: true });
      return;
    }
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByText('墨客示例书', { exact: true })).toBeVisible();
    const after = await page.evaluate(() => ({
      documents: Number(sessionStorage.getItem('fixture-document-count')),
      marker: window.name, receipt: sessionStorage.getItem('moke-reader-return-v1'),
      navigationType: performance.getEntriesByType('navigation')[0]?.type,
    }));
    expect(after).toEqual({ documents: before + 1, marker: '', receipt: null, navigationType: 'navigate' });
    expect(requests.filter(url => /\/api\//.test(url))).toHaveLength(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`offline-${platform}.png`), fullPage: true });
    await writeFile(testInfo.outputPath('document-evidence.json'), JSON.stringify({ platform, before, after, errors, requests }, null, 2));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole('heading', { name: '服务器', exact: true })).toBeVisible();
  });
}
