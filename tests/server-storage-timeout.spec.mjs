import { test, expect } from '@playwright/test';

const base = process.env.MOKE_TAURI_TEST_BASE_URL;
test.skip(!base, 'Requires the Tauri frontend with synthetic IPC; this is not device evidence.');

for (const width of [1280, 390]) {
  test(`a hung list read offers a usable offline library and retains its lock at ${width}px`, async ({ page }, testInfo) => {
    const errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install();
    await page.addInitScript(() => {
      localStorage.setItem('moke-privacy-consent', '2026-08-14');
      localStorage.setItem('moke-server-storage', JSON.stringify({ version: 1, state: { savedServers: [] } }));
      sessionStorage.setItem('fixture-document-count', String(Number(sessionStorage.getItem('fixture-document-count') || 0) + 1));
      const book = {
        id: 'https://offline.example.test::downloaded::epub', serverUrl: 'https://offline.example.test',
        bookId: 'downloaded', title: '未加入书架的下载', author: '离线作者', inShelf: false,
        fileName: 'downloaded.epub', filePath: '/fixture/books/downloaded.epub',
        mimeType: 'application/epub+zip', fileSize: 1234, updatedAt: 1,
      };
      window.fixtureIpc = [];
      let release, nextCallback = 1;
      const pending = new Promise(resolve => { release = resolve; });
      window.fixtureReleaseRead = () => release(false);
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback() { return nextCallback++; },
        unregisterCallback() {},
        convertFileSrc: () => '/samples/moke-sample.epub',
        async invoke(command, args) {
          window.fixtureIpc.push({ command, path: args?.path });
          if (command === 'moke_runtime_platform') return 'ios';
          if (command === 'moke_list_downloaded_books') return [book];
          if (command === 'plugin:fs|exists') {
            if (args.path === 'books/.servers/moke-server-storage.json') return pending;
            return false;
          }
          if (command === 'plugin:window|get_all_windows') return ['main'];
          if (command === 'plugin:event|listen') return nextCallback++;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:window|scale_factor') return 1;
          if (command === 'plugin:window|inner_size') return { width: innerWidth, height: innerHeight };
          if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0, bottom: 0 };
          if (command === 'plugin:native-bridge|get_status_bar_height') return { height: 0 };
          if (command === 'plugin:native-bridge|set_system_ui_visibility') return { success: true };
          if (command === 'moke_get_download_directory') return null;
          throw new Error('Unsupported synthetic IPC command: ' + command);
        },
      };
    });
    await page.goto(base + '/welcome', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('正在加载服务器列表…', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.fixtureIpc.filter(call => call.path === 'books/.servers/moke-server-storage.json').length)).toBe(1);
    await page.clock.fastForward(8500);
    await expect(page.locator('main').getByRole('alert')).toContainText('服务器列表读取超时');
    await expect(page.getByRole('button', { name: '先使用离线书库', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '重试加载', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保留原数据并重建列表', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('timeout-exit.png') });
    await page.getByRole('button', { name: '先使用离线书库', exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByText('未加入书架的下载', { exact: true })).toBeVisible();
    await page.evaluate(() => window.fixtureReleaseRead());
    await expect(page.getByText('未加入书架的下载', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/library$/);
    await page.screenshot({ path: testInfo.outputPath('offline-library.png') });
    await page.goBack();
    await expect(page.getByText('尚未加入服务器', { exact: true })).toBeVisible();
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '加入服务器', exact: true })).toBeEnabled();
    const evidence = await page.evaluate(() => ({
      documents: Number(sessionStorage.getItem('fixture-document-count')),
      reads: window.fixtureIpc.filter(call => call.path === 'books/.servers/moke-server-storage.json').length,
      writes: window.fixtureIpc.filter(call => /^plugin:fs\|(?:mkdir|open|write|rename|remove)$/.test(call.command)),
    }));
    expect(evidence).toEqual({ documents: 1, reads: 1, writes: [] });
    expect(apiRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
