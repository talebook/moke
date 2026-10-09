import { test, expect } from '@playwright/test';
import { waitForComicScroll } from './helpers/comic-scroll.mjs';

const BASE_URL = process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const SERVER_URL = 'https://books.test';
const BOOK_ID = '42';

async function installTauriHttpMock(page, { offlineMode = false, mediaType = 'comic', format = 'cbz', failPage = false, denied = false, preference = 'system', pageCount = 4, mixedSizes = false, imageBytes = 0, nativeDelay = 0, annotations = false, searchDownload = false, shortPages = false, eink = false } = {}) {
  await page.addInitScript(({ serverUrl, bookId, offlineMode, mediaType, format, failPage, denied, preference, pageCount, mixedSizes, imageBytes, nativeDelay, annotations, searchDownload, shortPages, eink }) => {
    const requests = new Map();
    const responseBodies = new Map();
    const httpRequests = [];
    const commands = [];
    const events = [];
    const posts = [];
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
    const pageDimensions = index => shortPages ? { width: 900, height: 160 } : mixedSizes && index % 2 ? { width: 900, height: 600 } : { width: 800, height: 1100 };
    const landscape = document.createElement('canvas'); landscape.width = 900; landscape.height = 600;
    landscape.getContext('2d').fillRect(0, 0, 900, 600);
    const landscapePng = Uint8Array.from(atob(landscape.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    const short = document.createElement('canvas'); short.width = 900; short.height = 160;
    short.getContext('2d').fillRect(0, 0, 900, 160);
    const shortPng = Uint8Array.from(atob(short.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    const imageFor = index => {
      const bytes = shortPages ? shortPng : mixedSizes && index % 2 ? landscapePng : png;
      if (!imageBytes) return bytes;
      const padded = new Uint8Array(imageBytes); padded.set(bytes); return padded;
    };
    // Minimal valid ZIP tail for the real download/storage validation path.
    const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const nativeRecord = { id: `${serverUrl}::${bookId}::${format}`, serverUrl, bookId, title: '漫画测试',
      fileName: `fixture.${format}`, filePath: `/tmp/fixture.${format}`, updatedAt: Date.now(), fileSize: 1000 };
    const nativeBooks = searchDownload ? JSON.parse(localStorage.getItem('moke-test-native-downloads') || '[]') : [nativeRecord];

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
            media_type: mediaType === 'missing' ? undefined : mediaType,
            authors: ['Moke 测试'],
            files: [{ format, size: 440912 }],
            state: { wants: false, download: 0 },
          },
        };
      }
      if (path === '/api/shelf') return { err: 'ok', books: [payloadFor(`${serverUrl}/api/book/${bookId}`).book] };
      if (path === '/api/search') return { err: 'ok', books: [payloadFor(`${serverUrl}/api/book/${bookId}`).book] };
      if (path.endsWith('/annotations')) return { err: 'ok', contract: 'talebook.annotations.v2', annotations: [
        { id: 1, book_id: 42, annotation_type: 'note', is_private: true, content: 'Located note', chapter: 'Chapter 1', cfi: 'epubcfi(/6/2!/4/2)', sources: [] },
        { id: 2, book_id: 42, annotation_type: 'note', is_private: true, content: 'Chapter note', chapter: 'Chapter 2', sources: [] },
      ] };
      if (path.endsWith('/readstate')) return { err: 'ok', read_state: 1, wants: true };
      if (path.endsWith('/comic/pages')) return denied ? { err: 'comic.no_permission' } : {
        err: 'ok', contract_version: 1, book_id: 42, title: '漫画测试', revision: 'rev-1', pages_count: pageCount,
        pages: Array.from({ length: pageCount }, (_, index) => ({ id: `p${index}`, index, ...pageDimensions(index), mime_type: 'image/png', url: `https://evil.test/page?token=secret` })),
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
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      invoke: async (command, args = {}) => {
        commands.push(command);
        events.push({ time: performance.now(), command, rid: args.rid, url: args.clientConfig?.url, method: args.clientConfig?.method });
        if (command === 'moke_build_info') return { channel: 'preview', previewCompiled: true };
        if (command === 'moke_preview_entitlement_status') {
          const expiresAt = Math.floor(Date.now() / 1000) + 600;
          return { state: 'active', serviceConfigured: true, deviceId: 'fixture-device', subject: 'fixture',
            capabilities: ['foundation'], expiresAt, offlineUntil: expiresAt, message: 'fixture' };
        }
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
            const body = JSON.parse(new TextDecoder().decode(new Uint8Array(request.data)));
            posts.push({ time: performance.now(), url: request.url, method: request.method, body });
            progress = body.progress;
            window.__COMIC_PROGRESS__ = progress;
          }
          if (/comic\/pages\/\d+/.test(request.url)) {
            response.status = failPage ? 403 : 200;
            response.headers = [['content-type', 'image/png']]; response.body = imageFor(Number(new URL(request.url).pathname.split('/').pop()));
          }
          if (/\/api\/book\/42\.(epub|pdf)$/.test(new URL(request.url).pathname)) {
            response.headers = [['content-type', format === 'epub' ? 'application/epub+zip' : 'application/pdf'], ['content-length', String(epubBytes.length)]];
            response.body = epubBytes;
          }
          const responseRid = nextRid++;
          events.push({ time: performance.now(), responseRid, url: request.url, status: response.status });
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
          const body = typeof responseBody.body === 'string' ? new TextEncoder().encode(responseBody.body) : responseBody.body;
          const chunk = new Uint8Array(body.length + 1); chunk.set(body); return chunk;
        }
        if (command.startsWith('plugin:http|fetch_cancel')) return null;
        if (command === 'plugin:event|listen') return nextRid++;
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'plugin:os|platform') return 'linux';
        if (command === 'moke_list_downloaded_books') {
          if (nativeDelay) await new Promise(resolve => setTimeout(resolve, nativeDelay));
          return nativeBooks;
        }
        if (command === 'moke_record_downloaded_book') {
          nativeBooks.splice(0, nativeBooks.length, { ...args.book, filePath: `/app-data/${args.book.relativePath}`, fileSize: epubBytes.length });
          localStorage.setItem('moke-test-native-downloads', JSON.stringify(nativeBooks));
          return null;
        }
        if (command === 'plugin:path|resolve_directory') return '/app-data';
        if (command === 'plugin:path|join') return args.paths.join('/');
        if (command === 'plugin:path|dirname') return args.path.slice(0, args.path.lastIndexOf('/'));
        if (command === 'plugin:fs|open') return nextRid++;
        if (command === 'plugin:fs|write') return args.data.length;
        if (command === 'plugin:fs|exists') return false;
        if (command === 'plugin:fs|stat') return { isFile: true, size: epubBytes.length };
        if (command === 'plugin:fs|seek') return 0;
        if (command === 'plugin:fs|read') {
          const bytes = new Uint8Array(epubBytes.length + 8); bytes.set(epubBytes); bytes[bytes.length - 1] = epubBytes.length; return bytes;
        }
        return null;
      },
      transformCallback: () => nextCallbackId++,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__MOKE_TEST_HTTP_REQUESTS__ = httpRequests;
    window.__MOKE_COMMANDS__ = commands;
    window.__COMIC_HTTP_EVENTS__ = events;
    window.__COMIC_POSTS__ = posts;
    if (!localStorage.getItem('moke-settings')) localStorage.setItem('moke-settings', JSON.stringify({ state: { readerPreference: preference, eink }, version: 0 }));

    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    if (!localStorage.getItem('moke-server-storage')) localStorage.setItem('moke-server-storage', JSON.stringify({
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
          annotationApiStatus: annotations ? 'supported' : 'unsupported',
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
  }, { serverUrl: SERVER_URL, bookId: BOOK_ID, offlineMode, mediaType, format, failPage, denied, preference, pageCount, mixedSizes, imageBytes, nativeDelay, annotations, searchDownload, shortPages, eink });
}

test.beforeEach(async ({ page }) => {
  page.comicDiagnostics = { errors: [], console: [], failed: [] };
  page.on('pageerror', error => page.comicDiagnostics.errors.push(error.message));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) page.comicDiagnostics.console.push({ type: message.type(), text: message.text() });
  });
  page.on('requestfailed', request => page.comicDiagnostics.failed.push({ url: request.url(), error: request.failure() }));
});

test.afterEach(async ({ page }, testInfo) => {
  // Page creation can fail before beforeEach runs. Preserve that first error
  // instead of masking it with another exception from the diagnostic hook.
  if (!page || page.isClosed()) {
    await testInfo.attach('comic-transport', { body: JSON.stringify({ diagnosticError: 'Page unavailable after fixture failure or closure' }), contentType: 'application/json' });
    return;
  }
  const state = await page.evaluate(() => ({ url: location.href, text: document.body.innerText,
    count: document.querySelector('.kr-page-count')?.textContent,
    events: window.__COMIC_HTTP_EVENTS__, posts: window.__COMIC_POSTS__, progress: window.__COMIC_PROGRESS__,
  })).catch(error => ({ diagnosticError: error.message }));
  await testInfo.attach('comic-transport', { body: JSON.stringify({ ...state, ...page.comicDiagnostics }), contentType: 'application/json' });
  if (testInfo.status !== testInfo.expectedStatus) await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => {});
});

for (const width of [390, 1280]) {
  test(`comic renders, turns, restores, saves and exits at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installTauriHttpMock(page);
    await page.goto(`${BASE_URL}/detail?id=42`);
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

for (const preference of ['embedded', 'system']) {
  for (const downloaded of [false, true]) {
    test(`Preview continue reading opens comic online with ${preference} preference (${downloaded ? 'downloaded' : 'not downloaded'})`, async ({ page }) => {
      await installTauriHttpMock(page, { preference, searchDownload: !downloaded });
      await page.goto(`${BASE_URL}/detail?id=42&continue=1`);
      await expect(page.locator('.kr-page-count')).toHaveText('2 / 4');
      expect(new URL(page.url()).searchParams.has('continue')).toBe(false);
      const entry = await page.evaluate(() => JSON.parse(localStorage.getItem('moke-continue-reading')).entries['https://books.test::online']);
      expect(entry.bookId).toBe('42');
      expect(entry.format).toBe('cbz');
      await page.getByRole('button', { name: 'Exit reader' }).click();
      await expect(page.locator('.kr-reader')).toHaveCount(0);
      await expect(page.getByTestId('online-read-action')).toBeVisible();
      expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader') || window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-settings')).state.readerPreference)).toBe(preference);
    });
  }
}

test('Preview continue reading in offline mode explains the comic limitation without network access', async ({ page }) => {
  await installTauriHttpMock(page, { offlineMode: true });
  await page.goto(`${BASE_URL}/detail?id=42&continue=1`);
  await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
  expect(new URL(page.url()).searchParams.has('continue')).toBe(false);
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);
  expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader') || window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
});

for (const format of ['epub', 'pdf']) {
  test(`Preview continue reading for comic ${format} explains the format gap`, async ({ page }) => {
    await installTauriHttpMock(page, { format });
    await page.goto(`${BASE_URL}/detail?id=42&continue=1`);
    await expect(page.locator('.moke-comic-state[role=alert]')).toContainText('漫画型 EPUB/PDF');
    expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader') || window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
  });

  test(`comic ${format} explains the format gap without opening ebook reader`, async ({ page }) => {
    await installTauriHttpMock(page, { format });
    await page.goto(`${BASE_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.moke-comic-state[role=alert]')).toContainText('漫画型 EPUB/PDF');
    expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__.some(u => u.includes('/comic/')))).toBe(false);
  });
}

test('manifest permission denial and page failure both show actionable errors', async ({ page }) => {
  await installTauriHttpMock(page, { denied: true });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByTestId('online-read-action').click();
  await expect(page.locator('.moke-comic-state[role=alert]')).toContainText('权限');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
});

test('page HTTP failure is visible with reload and return controls', async ({ page }) => {
  await installTauriHttpMock(page, { failPage: true });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByTestId('online-read-action').click();
  await expect(page.locator('.moke-comic-notice')).toContainText('权限');
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
});

test('ebook uses the current system preference even from the primary action', async ({ page }) => {
  await installTauriHttpMock(page, { format: 'epub', mediaType: 'ebook' });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await expect(page.getByTestId('online-read-action')).toHaveText('阅读');
  await page.getByTestId('online-read-action').click();
  await expect.poll(() => page.evaluate(() => window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(true);
  expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader'))).toBe(false);
});

for (const entry of ['/shelf', '/user/history']) {
  test(`comic opens through actual ${entry} navigation`, async ({ page }) => {
    await installTauriHttpMock(page, { mediaType: 'unknown' });
    await page.goto(`${BASE_URL}${entry}`);
    await page.locator('a[href="/detail?id=42"]').first().click();
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('2 / 4');
  });
}

test('offline comic displays limitation and never requests server or opens ebook reader', async ({ page }) => {
  await installTauriHttpMock(page, { offlineMode: true });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByTestId('offline-read-primary-action').click();
  await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);
  expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
});

test('changing the preference in Settings immediately changes ebook opening', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await installTauriHttpMock(page, { mediaType: 'ebook', format: 'epub', preference: 'embedded' });
  await page.goto(`${BASE_URL}/detail?id=42`);
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
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByTestId('offline-download-action').click();
  await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
  expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__.some(u => u.includes('/comic/')))).toBe(false);
});

async function offlineRows(page) {
  return page.evaluate(async () => {
    // Inspect the app's database without creating an empty one before startup.
    if (!(await indexedDB.databases()).some(db => db.name === 'moke-offline-books')) return [];
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('moke-offline-books'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    if (!db.objectStoreNames.contains('books')) { db.close(); return []; }
    const rows = await new Promise((resolve, reject) => {
      const r = db.transaction('books').objectStore('books').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    db.close(); return rows.filter(row => row.bookId);
  });
}

for (const width of [390, 1280]) {
  test(`long webtoon keeps mixed page geometry and progress after eviction at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installTauriHttpMock(page, { pageCount: 30, mixedSizes: true });
    await page.goto(`${BASE_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('2 / 30');
    await page.getByRole('button', { name: 'Open reader settings', exact: true }).click();
    await page.locator('.kr-settings select').first().selectOption('webtoon');
    await page.getByRole('button', { name: 'Close reader settings' }).click();
    await expect(page.locator('.kr-continuous img')).toHaveCount(30);
    const geometry = () => page.locator('.kr-continuous img').evaluateAll(imgs => imgs.map(img => {
      const r = img.getBoundingClientRect(); return { width: r.width, height: r.height, src: img.src };
    }));
    await expect.poll(async () => (await geometry()).every((r, i) => Math.abs(r.height / r.width - (i % 2 ? 600 / 900 : 1100 / 800)) < 0.005)).toBe(true);
    // More than twelve different loaded pages must exercise the count eviction.
    for (const i of [0, 5, 10, 15, 20, 25, 29]) {
      await page.locator('.kr-continuous').evaluate((el, i) => el.querySelectorAll('img')[i].scrollIntoView({ block: 'start', behavior: 'instant' }), i);
      await expect.poll(() => page.locator('.kr-continuous img').nth(i).evaluate(img => img.src.startsWith('blob:'))).toBe(true);
    }
    await page.locator('.kr-reader').focus();
    await page.keyboard.press('Home');
    const start = await waitForComicScroll(page, 'start');
    expect(start.top).toBe(0);
    await expect(page.locator('.kr-page-count')).toHaveText('1 / 30');
    await page.keyboard.press('End');
    const end = await waitForComicScroll(page, 'end');
    expect(Math.abs(end.top - end.max)).toBeLessThanOrEqual(1);
    await testInfo.attach('settled-scroll', { body: JSON.stringify({ start, end }), contentType: 'application/json' });
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await expect.poll(() => page.evaluate(() => window.__COMIC_PROGRESS__)).toMatchObject({ pageIndex: 29, percent: 100, completed: true });
    expect(await page.evaluate(() => window.__COMIC_POSTS__.at(-1))).toMatchObject({
      method: 'POST', url: `${SERVER_URL}/api/book/42/comic/progress`,
      body: { progress: { pageIndex: 29, percent: 100, completed: true } },
    });
    const after = await geometry();
    expect(after.some(r => r.src.startsWith('data:image/svg+xml'))).toBe(true);
    expect(after.every((r, i) => Math.abs(r.height / r.width - (i % 2 ? 600 / 900 : 1100 / 800)) < 0.005)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`comic-webtoon-${width}.png`) });
    await page.getByRole('button', { name: 'Exit reader' }).click();
    expect(await page.evaluate(() => window.__COMIC_PROGRESS__)).toMatchObject({ pageIndex: 29, percent: 100, completed: true });
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await page.getByRole('button', { name: 'Open reader settings', exact: true }).click();
    await page.locator('.kr-settings select').first().selectOption('webtoon');
    await page.getByRole('button', { name: 'Close reader settings' }).click();
    await waitForComicScroll(page, 'end');
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await expect.poll(() => page.evaluate(() => window.__COMIC_PROGRESS__)).toMatchObject({ pageIndex: 29, percent: 100, completed: true });
    await page.getByRole('button', { name: 'Exit reader' }).click();
  });
}

async function enableWebtoon(page, animations = true) {
  await page.getByRole('button', { name: 'Open reader settings', exact: true }).click();
  await page.locator('.kr-settings select').first().selectOption('webtoon');
  await page.getByRole('checkbox', { name: 'Animate transitions' }).setChecked(animations);
  await page.getByRole('button', { name: 'Close reader settings' }).click();
}

async function pageScrollTop(page, index) {
  return page.locator('.kr-continuous').evaluate((scroller, index) => {
    const image = scroller.querySelectorAll('img')[index];
    return Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
      image.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
  }, index);
}

for (const change of ['expand', 'shrink', 'rotate-wide', 'rotate-tall', 'image-grow', 'image-shrink']) {
  test(`webtoon follows its logical End target through ${change}`, async ({ page }, testInfo) => {
    const width = change === 'expand' || change === 'rotate-tall' ? 390 : 1280;
    const height = change === 'rotate-tall' ? 1280 : 900;
    await page.setViewportSize({ width, height });
    await installTauriHttpMock(page, { pageCount: 30, mixedSizes: true });
    await page.goto(`${BASE_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click();
    await enableWebtoon(page);
    await page.locator('.kr-reader').focus();
    await page.keyboard.press('Home');
    await waitForComicScroll(page, 'start');
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const el = document.querySelector('.kr-continuous');
      return el.scrollTop > 100 && el.scrollTop < el.scrollHeight - el.clientHeight - 100;
    });
    const inFlight = await page.locator('.kr-continuous').evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    if (change.startsWith('image-')) {
      // Late image geometry affects every preceding page, including recycled
      // placeholders, while the final page stays a short landscape image.
      await page.locator('.kr-continuous img').evaluateAll((images, grow) => {
        for (const image of images.slice(0, -1)) image.style.height = `${image.height * (grow ? 1.5 : 0.5)}px`;
      }, change === 'image-grow');
    } else {
      await page.setViewportSize(change === 'expand' ? { width: 1280, height: 900 }
        : change === 'shrink' ? { width: 390, height: 900 }
          : change === 'rotate-wide' ? { width: 900, height: 1280 } : { width: 1280, height: 390 });
    }
    // Inspect the actual stopped position first so the old resource yields a
    // useful assertion failure instead of hanging forever waiting for End.
    const end = await waitForComicScroll(page, 'current');
    // In a short landscape viewport the final image can be taller than the
    // viewport: its reachable page-start (not the image bottom) is the target.
    const expectedTarget = await pageScrollTop(page, 29);
    await testInfo.attach('dynamic-target-geometry', { body: JSON.stringify({ change, inFlight, end, expectedTarget }), contentType: 'application/json' });
    expect(Math.abs(end.top - expectedTarget)).toBeLessThanOrEqual(1);
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress)).toMatchObject({ pageId: 'p29', pageIndex: 29, percent: 100, completed: true });
    // Both a programmatic scroll and real wheel movement must update the page
    // and produce a NEW final POST after the 350ms write debounce.
    const beforeTop = await page.evaluate(() => window.__COMIC_POSTS__.length);
    await page.locator('.kr-continuous').evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
    await waitForComicScroll(page, 'start');
    await expect(page.locator('.kr-page-count')).toHaveText('1 / 30');
    await expect.poll(() => page.evaluate(() => ({ count: window.__COMIC_POSTS__.length, progress: window.__COMIC_POSTS__.at(-1)?.body.progress }))).toMatchObject({ count: beforeTop + 1, progress: { pageIndex: 0, completed: false } });
    await page.locator('.kr-reader').focus(); await page.keyboard.press('End');
    await waitForComicScroll(page, await pageScrollTop(page, 29));
    await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress.completed)).toBe(true);
    const beforeWheel = await page.evaluate(() => window.__COMIC_POSTS__.length);
    await page.mouse.move(100, 200); await page.mouse.wheel(0, -2400);
    const away = await waitForComicScroll(page, 'current');
    expect(away.max - away.top).toBeGreaterThan(1000);
    await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.length)).toBeGreaterThan(beforeWheel);
    await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress.completed)).toBe(false);
    const saved = await page.evaluate(() => window.__COMIC_POSTS__.at(-1).body.progress);
    await page.getByRole('button', { name: 'Exit reader' }).click();
    await expect(page.locator('.kr-reader')).toHaveCount(0);
    expect(await page.evaluate(() => window.__COMIC_POSTS__.at(-1).body.progress)).toEqual(saved);
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText(`${saved.pageIndex + 1} / 30`);
  });
}

for (const width of [390, 1280]) {
  test(`webtoon follows a programmatic interior page through resize from ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installTauriHttpMock(page, { pageCount: 30, mixedSizes: true });
    await page.goto(`${BASE_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click(); await enableWebtoon(page);
    await page.locator('.kr-reader').focus(); await page.keyboard.press('Home');
    await waitForComicScroll(page, 'start');
    await page.locator('.kr-toolbar--bottom input[type=range]').evaluate(input => {
      input.value = '20'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('.kr-continuous').scrollTop > 100);
    await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 900 });
    const stopped = await waitForComicScroll(page, 'current');
    expect(Math.abs(stopped.top - await pageScrollTop(page, 19))).toBeLessThanOrEqual(1);
    await expect(page.locator('.kr-page-count')).toHaveText('20 / 30');
    await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress)).toMatchObject({ pageIndex: 19, completed: false });
    await page.locator('.kr-reader').focus(); await page.keyboard.press('Home');
    await waitForComicScroll(page, 'start');
    await expect(page.locator('.kr-page-count')).toHaveText('1 / 30');
  });

  for (const mode of ['normal', 'reduced-motion', 'eink', 'no-animation']) {
    test(`webtoon manual boundaries and rapid explicit jumps at ${width}px (${mode})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      if (mode === 'reduced-motion') await page.emulateMedia({ reducedMotion: 'reduce' });
      await installTauriHttpMock(page, { pageCount: 30, mixedSizes: true, eink: mode === 'eink' });
      await page.goto(`${BASE_URL}/detail?id=42`);
      await page.getByTestId('online-read-action').click();
      await enableWebtoon(page, mode !== 'eink' && mode !== 'no-animation');
      await page.locator('.kr-continuous img').nth(29).waitFor();
      await page.locator('.kr-reader').focus();
      await page.keyboard.press('Home');
      await waitForComicScroll(page, 'start');
      await expect(page.locator('.kr-page-count')).toHaveText('1 / 30');
      // Real wheel input cancels programmatic selection and reaches the boundary.
      await page.mouse.move(width / 2, 450);
      await page.mouse.wheel(0, 100000);
      const bottom = await waitForComicScroll(page, 'end');
      await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
      await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress)).toMatchObject({ pageIndex: 29, percent: 100, completed: true });
      // Move beyond the last page's center at both viewport sizes.
      await page.mouse.wheel(0, -1200);
      const away = await waitForComicScroll(page, 'current');
      expect(away.top).toBeLessThan(away.max - 1);
      await expect(page.locator('.kr-page-count')).not.toHaveText('30 / 30');
      await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress.completed)).toBe(false);
      await page.locator('.kr-reader').focus();
      await page.keyboard.press('End');
      await page.keyboard.press('Home');
      await page.keyboard.press('End');
      // A short interior page must keep its explicit target after scrolling.
      await page.locator('.kr-toolbar--bottom input[type=range]').evaluate(input => {
        input.value = '8'; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const jump = await waitForComicScroll(page, await pageScrollTop(page, 7));
      await expect(page.locator('.kr-page-count')).toHaveText('8 / 30');
      await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress.pageIndex)).toBe(7);
      if (mode === 'normal') {
        await page.locator('.kr-reader').focus();
        await page.keyboard.press('Home');
        await waitForComicScroll(page, 'start');
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const el = document.querySelector('.kr-continuous');
          return el.scrollTop > 100 && el.scrollTop < el.scrollHeight - el.clientHeight - 100;
        });
        await page.mouse.wheel(0, -100);
        await waitForComicScroll(page, 'current');
        await expect(page.locator('.kr-page-count')).not.toHaveText('30 / 30');
      }
      await testInfo.attach('manual-and-jump-geometry', { body: JSON.stringify({ mode, width, bottom, away, jump }), contentType: 'application/json' });
      // Exit while a jump is pending: the logical target is saved, old frames
      // cannot mutate it after destruction, and the next instance restores it.
      await page.locator('.kr-reader').focus();
      await page.keyboard.press('End');
      await page.getByRole('button', { name: 'Exit reader' }).click();
      await expect(page.locator('.kr-reader')).toHaveCount(0);
      await expect(page.getByTestId('online-read-action')).toBeFocused();
      expect(await page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress)).toMatchObject({ pageIndex: 29, completed: true });
      await page.getByTestId('online-read-action').click();
      await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
      await enableWebtoon(page, mode !== 'eink' && mode !== 'no-animation');
      await waitForComicScroll(page, 'end');
      await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
      await page.evaluate(() => window.dispatchEvent(new Event('moke:native-back')));
      await expect(page.locator('.kr-reader')).toHaveCount(0);
      expect(await page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress)).toMatchObject({ pageIndex: 29, completed: true });
    });
  }
}

for (const input of ['pointer', 'touch', 'mode-switch']) {
  test(`webtoon releases an in-flight jump on ${input}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await installTauriHttpMock(page, { pageCount: 30, mixedSizes: true });
    await page.goto(`${BASE_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click(); await enableWebtoon(page);
    await page.locator('.kr-reader').focus(); await page.keyboard.press('Home');
    await waitForComicScroll(page, 'start');
    // Prepare the transport before starting the animation. A prior scroll
    // sample alone cannot prove the browser received the tap during the jump.
    const touchSession = input === 'touch' ? await page.context().newCDPSession(page) : null;
    if (touchSession) await page.evaluate(() => {
      document.addEventListener('touchstart', event => {
        const scroller = document.querySelector('.kr-continuous');
        window.__COMIC_TOUCH_RECEIPT__ = {
          time: performance.now(), trusted: event.isTrusted,
          inside: !!event.target.closest('.kr-continuous'),
          top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight,
        };
      }, { capture: true, once: true });
    });
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const el = document.querySelector('.kr-continuous');
      return el.scrollTop > 100 && el.scrollTop < el.scrollHeight - el.clientHeight - 100;
    });
    if (input === 'pointer') {
      await page.mouse.move(100, 200); await page.mouse.down(); await page.mouse.up();
    } else if (input === 'touch') {
      try {
        await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 200 }] });
        await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally { await touchSession.detach(); }
      const receipt = await page.evaluate(() => window.__COMIC_TOUCH_RECEIPT__);
      await testInfo.attach('touch-receipt', { body: JSON.stringify(receipt ?? null), contentType: 'application/json' });
      expect(receipt, 'a trusted touchstart must reach the moving scroller').toMatchObject({ trusted: true, inside: true });
      expect(receipt.top, 'touchstart must arrive after the jump begins').toBeGreaterThan(100);
      expect(receipt.top, 'touchstart must arrive before the jump reaches End').toBeLessThan(receipt.max - 100);
    } else {
      await page.getByRole('button', { name: 'Open reader settings', exact: true }).click();
      await page.locator('.kr-settings select').first().selectOption('ltr');
      await expect(page.locator('.kr-continuous')).toHaveCount(0);
      await page.locator('.kr-settings select').first().selectOption('webtoon');
      await page.getByRole('button', { name: 'Close reader settings' }).click();
      await waitForComicScroll(page, 'end');
      await page.locator('.kr-reader').focus(); await page.keyboard.press('Home');
    }
    await waitForComicScroll(page, 'current');
    // A real tap also hides the toolbar. Check the persistent live page status
    // and POST BEFORE another click can cancel a still-pending navigation.
    await expect(page.locator('.kr-reader > p')).not.toHaveText('Page 30 of 30');
    await expect.poll(() => page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress.completed)).toBe(false);
    if (!await page.locator('.kr-page-count').isVisible()) await page.getByRole('button', { name: 'Toggle reader controls', exact: true }).click();
    await expect(page.locator('.kr-page-count')).not.toHaveText('30 / 30');
    // Subsequent input must remain usable after cancellation.
    await page.locator('.kr-reader').focus(); await page.keyboard.press('End');
    await waitForComicScroll(page, 'end');
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await page.getByRole('button', { name: 'Exit reader' }).click();
    await expect(page.locator('.kr-reader')).toHaveCount(0);
  });
}

for (const pageCount of [1, 2]) {
  test(`webtoon preserves explicit selection in a short ${pageCount}-page document`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await installTauriHttpMock(page, { pageCount, shortPages: true });
    await page.goto(`${BASE_URL}/detail?id=42`);
    await page.getByTestId('online-read-action').click();
    await enableWebtoon(page);
    await page.locator('.kr-reader').focus();
    await page.keyboard.press('Home');
    const start = await waitForComicScroll(page, 'start');
    expect(start.max).toBe(0);
    await expect(page.locator('.kr-page-count')).toHaveText(`1 / ${pageCount}`);
    await page.keyboard.press('End');
    await waitForComicScroll(page, 'end');
    await expect(page.locator('.kr-page-count')).toHaveText(`${pageCount} / ${pageCount}`);
    await page.getByRole('button', { name: 'Exit reader' }).click();
    // Clicking starts the asynchronous exit flush. Destruction confirms that
    // the save finished before inspecting its real transport response.
    await expect(page.locator('.kr-reader')).toHaveCount(0);
    expect(await page.evaluate(() => window.__COMIC_POSTS__.at(-1)?.body.progress)).toMatchObject({ pageIndex: pageCount - 1, percent: 100, completed: true });
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText(`${pageCount} / ${pageCount}`);
  });
}

test('webtoon preserves original dimensions when the byte cache limit evicts images', async ({ page }) => {
  await installTauriHttpMock(page, { pageCount: 10, imageBytes: 10 * 1024 * 1024 });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByTestId('online-read-action').click();
  await page.getByRole('button', { name: 'Open reader settings', exact: true }).click();
  await page.locator('.kr-settings select').first().selectOption('webtoon');
  await page.locator('.kr-settings select').nth(1).selectOption('original');
  await page.getByRole('button', { name: 'Close reader settings' }).click();
  for (let i = 0; i < 10; i++) {
    await page.locator('.kr-continuous').evaluate((el, i) => el.querySelectorAll('img')[i].scrollIntoView({ block: 'start', behavior: 'instant' }), i);
    await expect.poll(() => page.locator('.kr-continuous img').nth(i).evaluate(img => img.src.startsWith('blob:')), { timeout: 15000 }).toBe(true);
  }
  const frames = await page.locator('.kr-continuous img').evaluateAll(imgs => imgs.map(img => ({ width: img.width, height: img.height, src: img.src })));
  expect(frames.some(frame => frame.src.startsWith('data:image/svg+xml'))).toBe(true);
  expect(frames.every(frame => frame.width === 800 && frame.height === 1100)).toBe(true);
  await page.locator('.kr-reader').focus(); await page.keyboard.press('End');
  await expect(page.locator('.kr-page-count')).toHaveText('10 / 10');
  await expect.poll(() => page.evaluate(() => window.__COMIC_PROGRESS__?.pageIndex)).toBe(9);
});

test('delayed native recovery retains a fresh comic PDF type in real IndexedDB', async ({ page }) => {
  await installTauriHttpMock(page, { format: 'pdf', nativeDelay: 1500 });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await expect.poll(async () => (await offlineRows(page)).find(row => row.bookId === '42')?.media_type).toBe('comic');
  // Persist the offline mode as a real disconnect, then reopen without a detail fetch.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('moke-server-storage')); stored.state.offlineMode = true;
    localStorage.setItem('moke-server-storage', JSON.stringify(stored));
  });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByTestId('offline-read-primary-action').click();
  await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
  expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader') || window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
});

for (const batch of [false, true]) {
  for (const [format, mediaType] of [['pdf', 'comic'], ['epub', 'comic'], ['pdf', 'ebook'], ['pdf', 'unknown'], ['pdf', 'missing']]) {
    test(`search ${batch ? 'batch' : 'single'} ${mediaType} ${format} download retains classification before offline open`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await installTauriHttpMock(page, { format, mediaType, searchDownload: true });
      await page.goto(`${BASE_URL}/search?q=comic`);
      const card = page.locator('a[href="/detail?id=42"]').first();
      await card.click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      // Wait for the successful readstate update: it must keep this menu open.
      await expect(page.getByRole('menuitem', { name: '移出书架', exact: true })).toBeVisible();
      if (batch) {
        await page.getByRole('menuitem', { name: '选择多本', exact: true }).click();
        await page.getByRole('button', { name: '下载', exact: true }).click();
      } else await page.getByRole('menuitem', { name: '下载', exact: true }).click();
      await expect.poll(async () => (await offlineRows(page)).find(row => row.bookId === '42')?.format).toBe(format);
      expect((await offlineRows(page)).find(row => row.bookId === '42')?.media_type).toBe(mediaType === 'missing' ? undefined : mediaType);
      expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__.some(url => new URL(url).pathname === '/api/book/42'))).toBe(false);
      await page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem('moke-server-storage')); stored.state.offlineMode = true;
        localStorage.setItem('moke-server-storage', JSON.stringify(stored));
      });
      await page.goto(`${BASE_URL}/detail?id=42`);
      await expect(page.getByRole('region', { name: '笔记与标注' })).toHaveCount(0);
      await page.getByTestId('offline-read-primary-action').click();
      if (mediaType === 'comic') {
        await expect(page.locator('.moke-comic-state')).toContainText('暂不支持本地离线解包');
        expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader') || window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
      } else await expect.poll(() => page.evaluate(() => window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(true);
      expect(await page.evaluate(() => window.__MOKE_TEST_HTTP_REQUESTS__)).toEqual([]);
    });
  }
}

for (const downloaded of [false, true]) {
  for (const format of ['cbz', 'pdf', 'epub']) {
    test(`comic ${format} notes disable unsupported precision (${downloaded ? 'downloaded' : 'not downloaded'}) and keep online reading available`, async ({ page }, testInfo) => {
      await installTauriHttpMock(page, { format, annotations: true, searchDownload: !downloaded });
      await page.goto(`${BASE_URL}/detail?id=42`);
      await expect(page.getByRole('button', { name: '漫画不支持笔记精确定位，请使用在线阅读' })).toBeDisabled();
      await expect(page.getByText('无精确位置，已按章节展示')).toBeVisible();
      if (format === 'cbz' && downloaded) await page.screenshot({ path: testInfo.outputPath('comic-note-location.png') });
      await page.getByTestId('online-read-action').click();
      if (format === 'cbz') await expect(page.locator('.kr-page-count')).toHaveText('2 / 4');
      else await expect(page.locator('.moke-comic-state')).toContainText('漫画型 EPUB/PDF');
      expect(await page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader') || window.__MOKE_COMMANDS__.includes('moke_open_downloaded_book'))).toBe(false);
    });
  }
}

test('ebook annotation precision still opens the embedded reader without changing the preference', async ({ page }) => {
  await installTauriHttpMock(page, { format: 'epub', mediaType: 'ebook', annotations: true });
  await page.goto(`${BASE_URL}/detail?id=42`);
  await page.getByRole('button', { name: '精确定位', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__MOKE_COMMANDS__.includes('open_reader'))).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moke-settings')).state.readerPreference)).toBe('system');
  await expect(page.locator('.moke-comic-reader')).toHaveCount(0);
});
