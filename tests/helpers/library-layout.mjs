export const LAYOUT_SERVER_URL = 'https://layout.books.test';
export const LAYOUT_BOOK = {
  id: '42', title: '布局回归测试书籍', author: '虚构作者',
  files: [{ format: 'epub' }], state: { wants: true, download: 0 },
};
export const LAYOUT_OFFLINE_BOOK = {
  id: `${LAYOUT_SERVER_URL}::42::epub`, serverUrl: LAYOUT_SERVER_URL,
  bookId: '42', title: LAYOUT_BOOK.title, author: LAYOUT_BOOK.author,
  inShelf: true, fileName: 'layout.epub', mimeType: 'application/epub+zip',
  filePath: '/test-data/layout.epub', fileSize: 2048, updatedAt: Date.now(),
};

// Use the same fictional responses for browser fetch and Tauri's HTTP bridge.
export async function installLibraryLayoutMock(page, {
  offlineMode = false, empty = false, continueReading = true, bookCount = 1,
  nativeRuntime = 'linux', nativeBooks = [], startup = false, nativeNavigation = false,
  previewState = 'active', previewDelayMs = 0, bookLoadDelayMs = 0, readerHandoffDelayMs = 100,
  readerFailure = false,
  windowLabel = 'main', bootstrapHandoff = false,
  theme = 'system', eink = false,
} = {}) {
  const books = empty ? [] : Array.from({ length: bookCount }, (_, index) => bookCount === 1
    ? LAYOUT_BOOK : { ...LAYOUT_BOOK, id: String(index + 1), title: `测试书籍 ${index + 1}` });
  const payloads = {
    '/api/shelf': { err: 'ok', books },
    '/api/library': { err: 'ok', books, total: books.length },
    '/api/search': { err: 'ok', books },
    '/api/book/nav': { err: 'ok', navs: [] },
    '/api/network/sources': { err: 'ok', items: [] },
    '/api/user/info': { err: 'ok', user: { id: 1, username: 'layout-test', extra: {} }, sys: { title: '布局测试书库' } },
    '/api/welcome': { err: 'not_invited' },
  };
  await page.route(`${LAYOUT_SERVER_URL}/**`, (route) => route.fulfill({
    json: payloads[new URL(route.request().url()).pathname] || { err: 'ok' },
  }));
  await page.addInitScript(({ serverUrl, payloads, offlineMode, continueReading, book, nativeRuntime, nativeBooks, startup, nativeNavigation, previewState, previewDelayMs, bookLoadDelayMs, readerHandoffDelayMs, readerFailure, windowLabel, bootstrapHandoff, theme, eink }) => {
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke-server-storage', JSON.stringify({ state: {
      serverUrl, offlineMode, hasHydrated: true, isConnected: !offlineMode,
      user: { id: 1, username: 'layout-test' },
      capabilities: {
        shelfApi: true, networkSourcesApi: true, readingStateApi: true,
        readingProgressApi: true, readingStatsApi: true, checkedAt: Date.now(),
      },
    }, version: 0 }));
    localStorage.setItem('moke-settings', JSON.stringify({ state: {
      continueReadingOnLaunch: startup, readerPreference: 'embedded', theme, eink,
    }, version: 0 }));
    if (continueReading) {
      const mode = offlineMode ? 'offline' : 'online';
      localStorage.setItem('moke-continue-reading', JSON.stringify({ version: 2, entries: {
        [offlineMode ? '__offline__' : `${serverUrl}::online`]: {
          serverUrl, mode, bookId: book.id, title: book.title, author: book.author,
          format: 'epub', progress: 0.3, updatedAt: Date.now(),
        },
      } }));
    }
    const requests = new Map();
    const bodies = new Map();
    let nextId = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: sessionStorage.getItem('layout-preview-entered') ? 'main' : windowLabel },
        currentWebview: { label: sessionStorage.getItem('layout-preview-entered') ? 'main' : windowLabel },
      },
      invoke: async (command, args = {}) => {
        if (command === 'moke_build_info') return { channel: 'preview', previewCompiled: true };
        if (command === 'moke_preview_entitlement_status') {
          await new Promise((resolve) => window.setTimeout(resolve, previewDelayMs));
          if (previewState === 'error') throw new Error('模拟授权检查失败');
          const expiresAt = Math.floor(Date.now() / 1000) + 600;
          return { state: previewState, serviceConfigured: true, deviceId: 'fixture-device', subject: 'fixture', capabilities: ['foundation'], expiresAt, offlineUntil: expiresAt, message: 'fixture' };
        }
        if (command === 'moke_preview_enter_app' && bootstrapHandoff) {
          sessionStorage.setItem('layout-preview-entered', 'true');
          // Simulate the native bootstrap replacing the current document.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.setTimeout(() => window.location.assign('/'), 100);
          return null;
        }
        if (command === 'plugin:http|fetch') {
          const id = nextId++;
          requests.set(id, args.clientConfig.url);
          return id;
        }
        if (command === 'plugin:http|fetch_send') {
          const url = requests.get(args.rid);
          const id = nextId++;
          bodies.set(id, JSON.stringify(payloads[new URL(url).pathname] || { err: 'ok' }));
          return { status: 200, statusText: 'OK', url, rid: id, headers: [['content-type', 'application/json']] };
        }
        if (command === 'plugin:http|fetch_read_body') {
          const body = bodies.get(args.rid);
          bodies.delete(args.rid);
          return body ? [...new TextEncoder().encode(body), 0] : [1];
        }
        if (command === 'plugin:event|listen') return nextId++;
        if (command === 'plugin:os|platform' || command === 'moke_runtime_platform') return nativeRuntime;
        if (command === 'moke_list_downloaded_books') {
          await new Promise((resolve) => window.setTimeout(resolve, bookLoadDelayMs));
          return nativeBooks;
        }
        if (command === 'moke_navigate' && nativeNavigation) {
          if (!args.path.startsWith('/') || args.path.startsWith('//')) throw new Error('模拟原生宿主拒绝外部导航');
          if (args.path.startsWith('/detail?')) {
            sessionStorage.setItem('layout-detail-opens', String(Number(sessionStorage.getItem('layout-detail-opens') || 0) + 1));
          }
          if (args.path.startsWith('/readest/')) {
            sessionStorage.setItem('layout-reader-opens', String(Number(sessionStorage.getItem('layout-reader-opens') || 0) + 1));
          }
          window.setTimeout(() => window.location.assign(args.path), args.path.startsWith('/readest/') ? readerHandoffDelayMs : 100);
        }
        if (command === 'open_reader') {
          sessionStorage.setItem('layout-reader-opens', String(Number(sessionStorage.getItem('layout-reader-opens') || 0) + 1));
          if (readerFailure) throw new Error('模拟阅读器启动失败');
        }
        if (command === 'plugin:native-bridge|get_status_bar_height') return { height: 0 };
        if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0 };
        if (command === 'plugin:native-bridge|set_system_ui_visibility') return { success: true };
        return null;
      },
      transformCallback: () => nextId++, unregisterCallback: () => {}, convertFileSrc: (path) => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { serverUrl: LAYOUT_SERVER_URL, payloads, offlineMode, continueReading, book: LAYOUT_BOOK, nativeRuntime, nativeBooks, startup, nativeNavigation, previewState, previewDelayMs, bookLoadDelayMs, readerHandoffDelayMs, readerFailure, windowLabel, bootstrapHandoff, theme, eink });
}
