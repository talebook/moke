import { test, expect } from '@playwright/test';
import { prepareReaderReturn } from '../src/lib/reader-return.ts';

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

function receiptFor(context) {
  const values = new Map(); let marker = '';
  prepareReaderReturn(context, {
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    getMarker: () => marker, setMarker: value => { marker = value; },
    getArrival: () => ({ pathname: '/library', navigationType: 'navigate' }),
  });
  return { raw: values.get('moke-reader-return-v1'), marker };
}

for (const [platform, mode] of [['ios', 'online'], ['ohos', 'online'], ['ios', 'offline'], ['ohos', 'offline'], ['ios', 'abandon'], ['ios', 'cold']]) {
  test(`delayed ${mode} library arrival preserves return authority until settled on simulated ${platform}`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const serverUrl = 'https://return.example.test';
    const receipt = mode === 'cold' ? null : receiptFor(mode === 'offline'
      ? { activeServerId: null, serverUrl: '', offlineMode: true, intent: 'offline-library' }
      : { activeServerId: 'return-a', serverUrl, offlineMode: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    await page.addInitScript(({ platform, serverUrl, receipt }) => {
      localStorage.setItem('moke-privacy-consent', '2026-08-14');
      localStorage.setItem('moke-server-storage', JSON.stringify({ version: 1, state: { savedServers: [
        { id: 'return-a', url: serverUrl, title: '返回测试书库', addedAt: '' },
      ] } }));
      const documents = Number(sessionStorage.getItem('return-fixture-documents') || 0) + 1;
      sessionStorage.setItem('return-fixture-documents', String(documents));
      if (documents === 1 && receipt) {
        sessionStorage.setItem('moke-reader-return-v1', receipt.raw);
        window.name = receipt.marker;
      }
      const book = { id: 42, title: '阅读返回在线藏书', author: '虚构作者', files: [] };
      const download = { id: `${serverUrl}::downloaded::epub`, serverUrl, bookId: 'downloaded',
        title: '阅读返回离线下载', inShelf: false, fileName: 'return.epub', filePath: '/fixture/books/return.epub',
        mimeType: 'application/epub+zip', fileSize: 1024, updatedAt: 1 };
      window.returnFixtureIpc = [];
      const requests = new Map(), bodies = new Map(); let nextRid = 1, release;
      const gate = new Promise(resolve => { release = resolve; });
      window.returnFixtureRelease = () => release(false);
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback() { return nextRid++; }, unregisterCallback() {},
        convertFileSrc: () => '/samples/moke-sample.epub',
        async invoke(command, args = {}) {
          window.returnFixtureIpc.push({ command, path: args.path, url: args.clientConfig?.url });
          if (command === 'moke_runtime_platform' || command === 'plugin:os|platform') return platform;
          if (command === 'moke_list_downloaded_books') return [download];
          if (command === 'plugin:fs|exists') return args.path === 'books/.servers/moke-server-storage.json' ? gate : false;
          if (command === 'plugin:window|get_all_windows') return ['main'];
          if (command === 'plugin:event|listen') return nextRid++;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:window|scale_factor') return 1;
          if (command === 'plugin:window|inner_size') return { width: innerWidth, height: innerHeight };
          if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0, bottom: 0 };
          if (command === 'plugin:native-bridge|get_status_bar_height') return { height: 0 };
          if (command === 'plugin:native-bridge|set_system_ui_visibility') return { success: true };
          if (command === 'moke_get_download_directory') return null;
          if (command === 'moke_navigate') {
            sessionStorage.setItem('return-fixture-document-navigations', String(Number(sessionStorage.getItem('return-fixture-document-navigations') || 0) + 1));
            window.location.assign(args.path); return null;
          }
          if (command === 'plugin:http|fetch') { const rid = nextRid++; requests.set(rid, args.clientConfig); return rid; }
          if (command === 'plugin:http|fetch_send') {
            const request = requests.get(args.rid), path = new URL(request.url).pathname;
            const data = path === '/api/user/info' ? { err: 'ok', sys: { title: '返回测试书库', version: 'fixture' }, user: { is_login: false } }
              : path === '/api/welcome' ? { err: 'free' }
              : ['/api/library', '/api/shelf'].includes(path) ? { err: 'ok', books: [book], total: 1 }
              : path === '/api/book/nav' ? { err: 'ok', navs: [] } : { err: 'api.not_found' };
            const rid = nextRid++; bodies.set(rid, JSON.stringify(data));
            return { status: 200, statusText: 'OK', url: request.url, headers: [['content-type', 'application/json']], rid };
          }
          if (command === 'plugin:http|fetch_read_body') {
            const body = bodies.get(args.rid); bodies.delete(args.rid);
            return body === undefined ? [1] : [...new TextEncoder().encode(body), 0];
          }
          if (command.startsWith('plugin:http|fetch_cancel')) return null;
          throw new Error('Unsupported return fixture IPC: ' + command);
        },
      };
    }, { platform, serverUrl, receipt });
    await page.goto(base + '/library', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => window.returnFixtureIpc.filter(call => call.path === 'books/.servers/moke-server-storage.json').length)).toBe(1);
    await page.clock.fastForward(8500);
    await expect(page.getByRole('button', { name: '返回服务器列表', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/library$/);
    expect(await page.evaluate(() => ({ documents: Number(sessionStorage.getItem('return-fixture-documents')),
      marker: window.name, raw: sessionStorage.getItem('moke-reader-return-v1'), http: window.returnFixtureIpc.filter(call => call.command === 'plugin:http|fetch') })))
      .toEqual({ documents: 1, marker: receipt?.marker ?? '', raw: receipt?.raw ?? null, http: [] });
    await page.screenshot({ path: testInfo.outputPath('pending-return.png') });
    if (mode === 'abandon') {
      await page.getByRole('button', { name: '返回服务器列表', exact: true }).click();
      await expect(page).toHaveURL(/\/welcome$/);
      expect(await page.evaluate(() => sessionStorage.getItem('moke-reader-return-v1'))).toBeNull();
      await page.evaluate(() => window.returnFixtureRelease());
      await expect(page.getByRole('button', { name: /返回测试书库/ })).toBeVisible();
      await expect(page).toHaveURL(/\/welcome$/);
      expect(await page.evaluate(() => Number(sessionStorage.getItem('return-fixture-documents')))).toBe(1);
      expect(await page.evaluate(() => window.returnFixtureIpc.filter(call => call.command === 'plugin:http|fetch'))).toEqual([]);
    } else {
      await page.evaluate(() => window.returnFixtureRelease());
      if (mode === 'cold') {
        await expect(page).toHaveURL(/\/welcome$/);
        await expect(page.getByRole('heading', { name: '服务器', exact: true })).toBeVisible();
        // iOS replaces the document through location.assign rather than the
        // Android/OHOS moke_navigate IPC, so observe the document itself.
        expect(await page.evaluate(() => Number(sessionStorage.getItem('return-fixture-documents')))).toBe(2);
        expect(await page.evaluate(() => window.returnFixtureIpc.filter(call => call.command === 'plugin:http|fetch'))).toEqual([]);
      } else {
        await expect(page.getByText(mode === 'offline' ? '阅读返回离线下载' : '阅读返回在线藏书', { exact: true })).toBeVisible();
        await expect(page).toHaveURL(/\/library$/);
        expect(await page.evaluate(() => ({ documents: Number(sessionStorage.getItem('return-fixture-documents')),
          marker: window.name, raw: sessionStorage.getItem('moke-reader-return-v1') })))
          .toEqual({ documents: 1, marker: '', raw: null });
        if (mode === 'offline') expect(await page.evaluate(() => window.returnFixtureIpc.filter(call => call.command === 'plugin:http|fetch'))).toEqual([]);
      }
    }
    expect(errors).toEqual([]);
  });
}
