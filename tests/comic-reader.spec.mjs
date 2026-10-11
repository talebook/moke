import { test, expect } from '@playwright/test';

const BASE_URL = process.env.MOKE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const SERVER_URL = 'https://books.test';
const BOOK_ID = '42';

async function installTauriHttpMock(page, { offlineMode = false, mediaType = 'comic', format = 'cbz', failPage = false, denied = false, preference = 'system', pageCount = 4, mixedSizes = false, imageBytes = 0, nativeDelay = 0, annotations = false, searchDownload = false } = {}) {
  await page.addInitScript(({ serverUrl, bookId, offlineMode, mediaType, format, failPage, denied, preference, pageCount, mixedSizes, imageBytes, nativeDelay, annotations, searchDownload }) => {
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
    const pageDimensions = index => mixedSizes && index % 2 ? { width: 900, height: 600 } : { width: 800, height: 1100 };
    const landscape = document.createElement('canvas'); landscape.width = 900; landscape.height = 600;
    landscape.getContext('2d').fillRect(0, 0, 900, 600);
    const landscapePng = Uint8Array.from(atob(landscape.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    const imageFor = index => {
      const bytes = mixedSizes && index % 2 ? landscapePng : png;
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
            response.headers = [['content-type', 'image/png']]; response.body = imageFor(Number(new URL(request.url).pathname.split('/').pop()));
          }
          if (/\/api\/book\/42\.(epub|pdf)$/.test(new URL(request.url).pathname)) {
            response.headers = [['content-type', format === 'epub' ? 'application/epub+zip' : 'application/pdf'], ['content-length', String(epubBytes.length)]];
            response.body = epubBytes;
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
    if (!localStorage.getItem('moke-settings')) localStorage.setItem('moke-settings', JSON.stringify({ state: { readerPreference: preference }, version: 0 }));

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
  }, { serverUrl: SERVER_URL, bookId: BOOK_ID, offlineMode, mediaType, format, failPage, denied, preference, pageCount, mixedSizes, imageBytes, nativeDelay, annotations, searchDownload });
}


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

for (const format of ['epub', 'pdf']) {
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
    await expect(page.locator('.kr-page-count')).toHaveText('1 / 30');
    await page.keyboard.press('End');
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await expect.poll(() => page.evaluate(() => window.__COMIC_PROGRESS__?.pageIndex)).toBe(29);
    const after = await geometry();
    expect(after.some(r => r.src.startsWith('data:image/svg+xml'))).toBe(true);
    expect(after.every((r, i) => Math.abs(r.height / r.width - (i % 2 ? 600 / 900 : 1100 / 800)) < 0.005)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`comic-webtoon-${width}.png`) });
    await page.getByRole('button', { name: 'Exit reader' }).click();
    await page.getByTestId('online-read-action').click();
    await expect(page.locator('.kr-page-count')).toHaveText('30 / 30');
    await page.getByRole('button', { name: 'Open reader settings', exact: true }).click();
    await page.locator('.kr-settings select').first().selectOption('webtoon');
    await page.getByRole('button', { name: 'Close reader settings' }).click();
    await expect.poll(() => page.evaluate(() => window.__COMIC_PROGRESS__?.pageIndex)).toBe(29);
    await page.getByRole('button', { name: 'Exit reader' }).click();
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
