import { test, expect } from '@playwright/test';
import { connectSavedServerFixture, enterOfflineModeFromWelcome, installSavedServerFixture, openFixtureBookDetail, openOfflineFixtureBookDetail } from './helpers/offline-mode-fixture.mjs';

const BASE_URL = process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const SERVER_URL = 'https://books.test';
const BOOK_ID = '42';

async function installTauriHttpMock(page, { downloaded = false } = {}) {
  await installSavedServerFixture(page, SERVER_URL);
  await page.addInitScript(({ serverUrl, bookId, downloaded }) => {
    const requests = new Map();
    const responseBodies = new Map();
    const httpRequests = [];
    const nativeOfflineBooks = downloaded ? [{
      id: `${serverUrl}::${bookId}::epub`,
      serverUrl,
      bookId,
      title: '离线阅读操作布局测试',
      author: 'Moke 测试',
      inShelf: true,
      fileName: 'offline-layout.epub',
      mimeType: 'application/epub+zip',
      updatedAt: Date.now(),
      filePath: '/tmp/offline-layout.epub',
      fileSize: 440912,
    }] : [];
    let nextRid = 1;
    let nextCallbackId = 1;

    const payloadFor = (url) => {
      const path = new URL(url).pathname;
      if (path === `/api/book/${bookId}`) {
        return {
          err: 'ok',
          book: {
            id: bookId,
            title: '在线阅读操作布局测试',
            authors: ['Moke 测试'],
            files: [
              { format: 'epub', size: 440912 },
              { format: 'pdf', size: 900000 },
            ],
            state: { wants: false, download: 0 },
          },
        };
      }
      if (path === '/api/shelf') return { err: 'ok', books: [payloadFor(`${serverUrl}/api/book/${bookId}`).book] };
      if (path === '/api/welcome') return { err: 'free' };
      if (path === '/api/user/info') {
        return { err: 'user.need_login', sys: { title: 'Moke 测试书库', version: '3.15.0' } };
      }
      return { err: 'page.not_found' };
    };

    const jsonResponse = (url) => ({
      status: 200,
      statusText: 'OK',
      url,
      headers: [['content-type', 'application/json']],
      body: JSON.stringify(payloadFor(url)),
    });

    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command, args = {}) => {
        if (command === 'moke_runtime_platform') return 'linux';
        if (command === 'plugin:window|get_all_windows') return ['main'];
        if (command === 'plugin:http|fetch') {
          const rid = nextRid++;
          requests.set(rid, args.clientConfig);
          httpRequests.push(args.clientConfig.url);
          return rid;
        }
        if (command === 'plugin:http|fetch_send') {
          const request = requests.get(args.rid);
          const response = jsonResponse(request?.url || `${serverUrl}/api/book/${bookId}`);
          const responseRid = nextRid++;
          responseBodies.set(responseRid, { body: response.body, sent: false });
          return {
            status: response.status,
            statusText: response.statusText,
            url: request?.url || response.url,
            headers: response.headers,
            rid: responseRid,
          };
        }
        if (command === 'plugin:http|fetch_read_body') {
          const responseBody = responseBodies.get(args.rid);
          if (!responseBody || responseBody.sent) {
            responseBodies.delete(args.rid);
            return [1];
          }
          responseBody.sent = true;
          return [...new TextEncoder().encode(responseBody.body), 0];
        }
        if (command.startsWith('plugin:http|fetch_cancel')) return null;
        if (command === 'plugin:event|listen') return nextRid++;
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'plugin:os|platform') return 'linux';
        if (command === 'moke_list_downloaded_books') return nativeOfflineBooks;
        return null;
      },
      transformCallback: () => nextCallbackId++,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__MOKE_TEST_HTTP_REQUESTS__ = httpRequests;

  }, { serverUrl: SERVER_URL, bookId: BOOK_ID, downloaded });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test(`online and download actions retain one-row layout on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installTauriHttpMock(page);
    await connectSavedServerFixture(page, BASE_URL, SERVER_URL);
    await openFixtureBookDetail(page, BOOK_ID);

    const group = page.getByTestId('book-primary-action-group');
    const online = page.getByTestId('online-read-action');
    const download = page.getByTestId('offline-download-action');
    const cover = page.locator('.book-cover-shadow');
    await expect(group).toBeVisible();
    await expect(online).toHaveText('在线阅读');
    await expect(download).toHaveAttribute('aria-label', '下载后阅读');
    await expect(download).toHaveAttribute('title', '下载后阅读');
    await expect(download).toBeEnabled();
    await download.focus();
    await expect(download).toBeFocused();

    const layout = await page.evaluate(() => {
      const rect = (testId) => document.querySelector(`[data-testid="${testId}"]`).getBoundingClientRect();
      const groupRect = rect('book-primary-action-group');
      const onlineRect = rect('online-read-action');
      const downloadRect = rect('offline-download-action');
      const coverRect = document.querySelector('.book-cover-shadow').getBoundingClientRect();
      const onlineElement = document.querySelector('[data-testid="online-read-action"]');
      const downloadElement = document.querySelector('[data-testid="offline-download-action"]');
      return {
        group: { x: groupRect.x, width: groupRect.width, height: groupRect.height },
        online: { x: onlineRect.x, y: onlineRect.y, width: onlineRect.width, height: onlineRect.height },
        download: { x: downloadRect.x, y: downloadRect.y, width: downloadRect.width, height: downloadRect.height },
        coverWidth: coverRect.width,
        onlineClientWidth: onlineElement.clientWidth,
        onlineScrollWidth: onlineElement.scrollWidth,
        downloadVisibleText: downloadElement.innerText.trim(),
      };
    });

    expect(layout.group.width).toBeCloseTo(layout.coverWidth, 0);
    expect(layout.group.height).toBe(44);
    expect(layout.online.y).toBeCloseTo(layout.download.y, 0);
    expect(layout.online.height).toBe(44);
    expect(layout.download.height).toBe(44);
    expect(layout.download.width).toBe(44);
    expect(layout.download.width).toBeLessThan(layout.online.width);
    expect(layout.download.x + layout.download.width).toBeCloseTo(layout.group.x + layout.group.width, 0);
    expect(layout.onlineScrollWidth).toBeLessThanOrEqual(layout.onlineClientWidth);
    expect(layout.downloadVisibleText).toBe('');

    await page.screenshot({
      path: testInfo.outputPath(`detail-actions-${viewport.name}.png`),
      fullPage: true,
    });
  });

  test(`offline mode exposes only its local reading action on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installTauriHttpMock(page, { downloaded: true });
    await enterOfflineModeFromWelcome(page, BASE_URL);
    await openOfflineFixtureBookDetail(page, BOOK_ID);

    const offlineRead = page.getByTestId('offline-read-primary-action');
    const cover = page.locator('.book-cover-shadow');
    await expect(offlineRead).toBeVisible();
    await expect(offlineRead).toHaveText('离线阅读');
    await expect(offlineRead).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('book-primary-action-group')).toHaveCount(0);
    await expect(page.getByTestId('online-read-action')).toHaveCount(0);
    await expect(page.getByTestId('offline-download-action')).toHaveCount(0);
    await offlineRead.focus();
    await expect(offlineRead).toBeFocused();

    const layout = await page.evaluate(() => {
      const action = document.querySelector('[data-testid="offline-read-primary-action"]');
      const coverElement = document.querySelector('.book-cover-shadow');
      const actionRect = action.getBoundingClientRect();
      const coverRect = coverElement.getBoundingClientRect();
      return {
        actionWidth: actionRect.width,
        actionHeight: actionRect.height,
        coverWidth: coverRect.width,
        httpRequests: window.__MOKE_TEST_HTTP_REQUESTS__.length,
      };
    });

    expect(layout.actionWidth).toBeCloseTo(layout.coverWidth, 0);
    expect(layout.actionHeight).toBe(44);
    expect(layout.httpRequests).toBe(0);
    await expect(cover).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath(`detail-actions-offline-${viewport.name}.png`),
      fullPage: true,
    });
  });
}

test('a cold v1 document restores only the server list and requires explicit offline entry again', async ({ page }) => {
  await installTauriHttpMock(page, { downloaded: true });
  await page.goto(`${BASE_URL}/detail?id=${BOOK_ID}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.locator('li button').filter({ hasText: SERVER_URL })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回当前书架', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);

  await page.getByRole('button', { name: '进入离线模式', exact: true }).click();
  await expect(page).toHaveURL(/\/shelf$/);
  await openOfflineFixtureBookDetail(page, BOOK_ID);
  await expect(page.getByTestId('offline-read-primary-action')).toHaveText('离线阅读');
  await expect(page.getByTestId('online-read-action')).toHaveCount(0);
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('moke-server-storage')));
  expect(persisted.version).toBe(1);
  expect(Object.keys(persisted.state)).toEqual(['savedServers']);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.locator('li button').filter({ hasText: SERVER_URL })).toBeVisible();
  await expect(page.getByTestId('offline-read-primary-action')).toHaveCount(0);
  await expect(page.getByTestId('online-read-action')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回当前书架', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);
});
