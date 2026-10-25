export const LAYOUT_SERVER_URL = 'https://layout.books.test';
export const LAYOUT_BOOK = {
  id: '42', title: '布局回归测试书籍', author: '虚构作者',
  files: [{ format: 'epub' }], state: { wants: true, download: 0 },
};

// Identical fictional responses cover web fetch and the native HTTP bridge.
export async function installLibraryLayoutMock(page, {
  empty = false, bookCount = 1, navs = [], nativeRuntime = 'linux',
  theme = 'system', eink = false,
} = {}) {
  const books = empty ? [] : Array.from({ length: bookCount }, (_, index) => bookCount === 1
    ? LAYOUT_BOOK : { ...LAYOUT_BOOK, id: String(index + 1), title: `测试书籍 ${index + 1}` });
  const payloads = {
    '/api/shelf': { err: 'ok', books },
    '/api/library': { err: 'ok', books, total: books.length },
    '/api/search': { err: 'ok', books },
    '/api/book/nav': { err: 'ok', navs },
    '/api/network/sources': { err: 'ok', items: [] },
    '/api/user/info': { err: 'ok', user: { id: 1, is_login: true, username: 'layout-test', extra: {} }, sys: { title: '布局测试书库' } },
    '/api/welcome': { err: 'not_invited' },
  };
  await page.route(`${LAYOUT_SERVER_URL}/**`, (route) => route.fulfill({
    json: payloads[new URL(route.request().url()).pathname] || { err: 'ok' },
  }));
  await page.addInitScript(({ serverUrl, payloads, nativeRuntime, theme, eink }) => {
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    localStorage.setItem('moke-server-storage', JSON.stringify({ state: {
      serverUrl, offlineMode: false, hasHydrated: true, isConnected: true,
      user: { id: 1, username: 'layout-test' },
      capabilities: {
        annotationApiStatus: 'unchecked', annotationApiCheckedAt: null,
        shelfApi: true, networkSourcesApi: true, readingStateApi: true,
        readingProgressApi: true, readingStatsApi: true, checkedAt: Date.now(),
      },
    }, version: 0 }));
    localStorage.setItem('moke-settings', JSON.stringify({ state: { theme, eink }, version: 0 }));
    const requests = new Map();
    const bodies = new Map();
    let nextId = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command, args = {}) => {
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
        if (command === 'ext_list_extensions') return [];
        if (command === 'moke_list_downloaded_books') return [];
        if (command === 'plugin:native-bridge|get_status_bar_height') return { height: 0 };
        if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0 };
        if (command === 'plugin:native-bridge|set_system_ui_visibility') return { success: true };
        return null;
      },
      transformCallback: () => nextId++, unregisterCallback: () => {}, convertFileSrc: (path) => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { serverUrl: LAYOUT_SERVER_URL, payloads, nativeRuntime, theme, eink });
}
