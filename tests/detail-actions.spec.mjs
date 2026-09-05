import { test, expect } from '@playwright/test';

const SERVER_URL = 'https://books.test';
const BOOK_ID = '42';

async function installTauriHttpMock(page) {
  await page.addInitScript(({ serverUrl, bookId }) => {
    const requests = new Map();
    const responseBodies = new Map();
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
      if (path === '/api/welcome') return { err: 'not_invited' };
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
      invoke: async (command, args = {}) => {
        if (command === 'plugin:http|fetch') {
          const rid = nextRid++;
          requests.set(rid, args.clientConfig);
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
        if (command === 'moke_list_downloaded_books') return [];
        return null;
      },
      transformCallback: () => nextCallbackId++,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke-server-storage', JSON.stringify({
      state: {
        serverUrl,
        offlineMode: false,
        protocol: 'https',
        host: 'books.test',
        port: '',
        hasHydrated: true,
        isConnected: true,
        user: null,
        capabilities: {
          shelfApi: true,
          annotationApiStatus: 'unsupported',
          annotationApiCheckedAt: Date.now(),
          readingStateApi: true,
          readingProgressApi: true,
          readingStatsApi: true,
          networkSourcesApi: true,
          checkedAt: Date.now(),
          version: '3.15.0',
        },
      },
      version: 0,
    }));
  }, { serverUrl: SERVER_URL, bookId: BOOK_ID });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test(`online and download actions retain one-row layout on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installTauriHttpMock(page);
    await page.goto(`http://127.0.0.1:3000/detail?id=${BOOK_ID}`, { waitUntil: 'domcontentloaded' });

    const group = page.getByTestId('book-primary-action-group');
    const online = page.getByTestId('online-read-action');
    const download = page.getByTestId('offline-download-action');
    const cover = page.locator('.book-cover-shadow');
    await expect(group).toBeVisible();
    await expect(online).toHaveText('在线阅读（EPUB）');
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
}
