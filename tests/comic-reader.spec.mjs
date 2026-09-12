import { test, expect } from '@playwright/test';

const SERVER_URL = 'https://books.test';
const BOOK_ID = '42';

async function installTauriHttpMock(page, { offlineMode = false, mediaType = 'comic', format = 'cbz', failPage = false, denied = false, preference = 'system' } = {}) {
  await page.addInitScript(({ serverUrl, bookId, offlineMode, mediaType, format, failPage, denied, preference }) => {
    const requests = new Map();
    const responseBodies = new Map();
    const httpRequests = [];
    const commands = [];
    let progress = { kind: 'comic', version: 1, pageId: 'p1', pageIndex: 1, percent: 50, completed: false };
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f9f2df'; ctx.fillRect(0, 0, 800, 1100);
    ctx.fillStyle = '#193c4b'; ctx.font = 'bold 56px sans-serif'; ctx.fillText('MOKE / COMIC', 60, 100);
    ctx.font = '24px sans-serif'; ctx.fillText('Reading integration fixture', 60, 145);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = ['#88afb9', '#d8a780', '#698b82'][i]; ctx.fillRect(60, 200 + i * 280, 680, 240);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(400, 310 + i * 280, 65, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#193c4b'; ctx.font = '28px sans-serif'; ctx.fillText('Panel ' + (i + 1), 90, 240 + i * 280);
    }
    const png = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    const nativeRecord = { id: `${serverUrl}::${bookId}::${format}`, serverUrl, bookId, title: '漫画测试',
      fileName: `fixture.${format}`, filePath: `/tmp/fixture.${format}`, updatedAt: Date.now(), fileSize: 1000 };

    let nextRid = 1;
    let nextCallbackId = 1;

    const payloadFor = (url) => {
      const path = new URL(url).pathname;
      if (path === `/api/book/${bookId}`) {
        return {
          err: 'ok',
          book: {
            id: bookId,
            title: '漫画测试',
            media_type: mediaType,
            authors: ['Moke 测试'],
            files: [{ format, size: 440912 }],
            state: { wants: false, download: 0 },
          },
        };
      }
      if (path === '/api/shelf') return { err: 'ok', books: [payloadFor(`${serverUrl}/api/book/${bookId}`).book] };
      if (path.endsWith('/readstate')) return { err: 'ok', read_state: 1, wants: true };
      if (path.endsWith('/comic/pages')) return denied ? { err: 'comic.no_permission' } : {
        err: 'ok', contract_version: 1, book_id: 42, title: '漫画测试', revision: 'rev-1', pages_count: 4,
        pages: [0,1,2,3].map(index => ({ id: `p${index}`, index, width: 800, height: 1100, mime_type: 'image/png', url: `https://evil.test/page?token=secret` })),
      };
      if (path.endsWith('/comic/progress')) return { err: 'ok', progress };
      if (path.endsWith('/progress')) return { err: 'ok', progress: {} };
      if (path === '/api/welcome') return { err: 'not_invited' };
      if (path === '/api/user/info') {
        return { err: 'ok', sys: { title: 'Moke 测试书库', version: '3.15.0' }, user: { id: 1, username: 'reader', is_login: true, extra: { read_history: [{ id: bookId, title: '漫画测试', state: { read_state: 1 } }] } } };
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
        commands.push(command);
        if (command === 'moke_runtime_platform') return 'linux';
        if (command === 'plugin:http|fetch') {
          const rid = nextRid++;
          requests.set(rid, args.clientConfig);
          httpRequests.push(args.clientConfig.url);
          return rid;
        }
        if (command === 'plugin:http|fetch_send') {
          const request = requests.get(args.rid);
          const response = jsonResponse(request?.url || `${serverUrl}/api/book/${bookId}`);
          if (request.url.includes('/comic/progress') && request.method === 'POST') {
            progress = JSON.parse(new TextDecoder().decode(new Uint8Array(request.data))).progress;
            window.__COMIC_PROGRESS__ = progress;
          }
          if (/comic\/pages\/\d+/.test(request.url)) {
            response.status = failPage ? 403 : 200;
            response.headers = [['content-type', 'image/png']]; response.body = png;
          }
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
          return [...(typeof responseBody.body === 'string' ? new TextEncoder().encode(responseBody.body) : responseBody.body), 0];
        }
        if (command.startsWith('plugin:http|fetch_cancel')) return null;
        if (command === 'plugin:event|listen') return nextRid++;
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'plugin:os|platform') return 'linux';
        if (command === 'moke_list_downloaded_books') return [nativeRecord];
        return null;
      },
      transformCallback: () => nextCallbackId++,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__MOKE_TEST_HTTP_REQUESTS__ = httpRequests;
    window.__MOKE_COMMANDS__ = commands;
    localStorage.setItem('moke-settings', JSON.stringify({ state: { readerPreference: preference }, version: 0 }));

    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke-server-storage', JSON.stringify({
      state: {
        serverUrl,
        offlineMode,
        protocol: 'https',
        host: 'books.test',
        port: '',
        hasHydrated: true,
        isConnected: !offlineMode,
        user: { id: 1, username: 'reader', name: 'reader' },
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
  }, { serverUrl: SERVER_URL, bookId: BOOK_ID, offlineMode, mediaType, format, failPage, denied, preference });
}


for (const width of [390, 1280]) {
  test(`comic renders, turns, restores, saves and exits at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installTauriHttpMock(page);
    await page.goto('http://127.0.0.1:3000/detail?id=42');
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('2 / 4');
    await expect.poll(() => page.locator('.kr-spread img').evaluate(img => img.src.startsWith('blob:') && img.naturalWidth === 800)).toBe(true);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.kr-page-count')).toHaveText('3 / 4');
    await expect.poll(() => page.evaluate(() => window.__COMIC_PROGRESS__?.pageIndex)).toBe(2);
    await page.screenshot({ path: testInfo.outputPath(`comic-${width}.png`) });
    await page.getByRole('button', { name: 'Exit reader' }).click();
    await expect(page.getByRole('dialog', { name: '漫画阅读：漫画测试' })).toHaveCount(0);
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('3 / 4');
    await page.evaluate(() => window.dispatchEvent(new Event('moke:native-back')));
    await expect(page.locator('.kr-reader')).toHaveCount(0);
    const state = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('moke-settings')), urls: window.__MOKE_TEST_HTTP_REQUESTS__, commands: window.__MOKE_COMMANDS__ }));
    expect(state.settings.state.readerPreference).toBe('system');
    expect(state.urls.every(url => !url.includes('token=') && !url.includes('evil.test'))).toBe(true);
    expect(state.commands).not.toContain('open_reader');
    expect(state.commands).not.toContain('moke_open_downloaded_book');
  });
}

for (const format of ['epub', 'pdf']) {
  test(`comic ${format} explains the format gap without opening ebook reader`, async ({ page }) => {
    await installTauriHttpMock(page, { format });
    await page.goto('http://127.0.0.1:3000/detail?id=42');
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.moke-comic-state[role=alert]')).toContainText('漫画型 EPUB/PDF');
    expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__.some(u => u.includes('/comic/')))).toBe(false);
  });
}

test('manifest permission denial and page failure both show actionable errors', async ({ page }) => {
  await installTauriHttpMock(page, { denied: true });
  await page.goto('http://127.0.0.1:3000/detail?id=42');
  await page.getByTestId('online-read-action').click();
  await expect(page.locator('.moke-comic-state[role=alert]')).toContainText('权限');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
});

test('page HTTP failure is visible with reload and return controls', async ({ page }) => {
  await installTauriHttpMock(page, { failPage: true });
  await page.goto('http://127.0.0.1:3000/detail?id=42');
  await page.getByTestId('online-read-action').click();
  await expect(page.locator('.moke-comic-notice')).toContainText('权限');
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
});

test('ebook uses the current system preference even from the primary action', async ({ page }) => {
  await installTauriHttpMock(page, { format: 'epub', mediaType: 'ebook' });
  await page.goto('http://127.0.0.1:3000/detail?id=42');
  await expect(page.getByTestId('online-read-action')).toHaveText('阅读');
  await page.getByTestId('online-read-action').click();
  await expect.poll(() => page.evaluate(() => window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(true);
  expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader'))).toBe(false);
});

for (const entry of ['/shelf', '/user/history']) {
  test(`comic opens through actual ${entry} navigation`, async ({ page }) => {
    await installTauriHttpMock(page, { mediaType: 'unknown' });
    await page.goto(`http://127.0.0.1:3000${entry}`);
    await page.locator('a[href="/detail?id=42"]').first().click();
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('2 / 4');
  });
}

test('offline comic displays limitation and never requests server or opens ebook reader', async ({ page }) => {
  await installTauriHttpMock(page, { offlineMode: true });
  await page.goto('http://127.0.0.1:3000/detail?id=42');
  await page.getByTestId('offline-read-primary-action').click();
  await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);
  expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
});

test('changing the preference in Settings immediately changes ebook opening', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await installTauriHttpMock(page, { mediaType: 'ebook', format: 'epub', preference: 'embedded' });
  await page.goto('http://127.0.0.1:3000/detail?id=42');
  await page.getByTestId('offline-download-action').click();
  await expect.poll(() => page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader'))).toBe(true);
  await page.locator('a[href="/settings"]').first().click();
  await page.getByRole('button', { name: '选择阅读器' }).click();
  await page.getByRole('option', { name: '系统默认应用' }).click();
  await page.goBack();
  await expect(page.getByTestId('online-read-action')).toHaveText('阅读');
  await page.getByTestId('online-read-action').click();
  await expect.poll(() => page.evaluate(() => window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(true);
});


test('downloaded comic offline action does not silently switch to online requests', async ({ page }) => {
  await installTauriHttpMock(page);
  await page.goto('http://127.0.0.1:3000/detail?id=42');
  await page.getByTestId('offline-download-action').click();
  await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__.some(u => u.includes('/comic/')))).toBe(false);
});
