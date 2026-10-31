export const AUTH_SERVER_URL = 'https://auth.books.test';

/** Fictional native HTTP/filesystem bridge; production application code stays intact. */
export async function installAuthNavigationMock(page, {
  failure = 'http401', comic = false, pausedDownloads = false, deferFailure = false,
} = {}) {
  await page.addInitScript(({ serverUrl, failure, comic, pausedDownloads, deferFailure }) => {
    const requests = new Map();
    const bodies = new Map();
    const files = new Map();
    const handles = new Map();
    const httpRequests = [];
    let nextId = 1;
    let releaseFailure;
    const failureGate = new Promise(resolve => { releaseFailure = resolve; });
    window.__AUTH_TEST_RELEASE_FAILURE__ = () => releaseFailure();
    const format = comic ? 'cbz' : 'epub';
    const books = ['42', '43'].map(id => ({
      id, title: `登录导航测试书籍 ${id}`, author: '虚构作者',
      media_type: comic ? 'comic' : 'ebook',
      files: [{ format, size: 1000 }], state: { wants: true, download: 0 },
    }));
    const failedResponse = () => ({
      status: failure === 'http401' ? 401 : failure === 'permission' ? 403 : 200,
      body: { err: failure === 'need_login' ? 'user.need_login' : failure === 'permission' ? 'user.no_permission' : 'http.401', msg: failure === 'permission' ? '没有权限' : '请先登录' },
    });
    const responseFor = (url) => {
      const path = new URL(url).pathname;
      let result = { status: 200, body: { err: 'ok' } };
      if (/\/api\/book\/\d+\.(epub|cbz)$/.test(path) || path.endsWith('/reader-bootstrap') || path.endsWith('/comic/pages')) {
        result = failedResponse();
        if (failure === 'progress_only' && path.endsWith('/comic/pages')) {
          result = { status: 200, body: { err: 'ok', contract_version: 1, book_id: 42,
            title: books[0].title, revision: 'fixture-1', pages_count: 1,
            pages: [{ id: 'page-1', index: 0, width: 800, height: 1100, mime_type: 'image/png' }] } };
        }
        if (failure === 'transfer' && /\.epub$/.test(path)) {
          return { status: 200, body: new Uint8Array([0x50, 0x4b, 3, 4]), broken: true,
            headers: [['content-type', 'application/epub+zip'], ['content-length', '1000']] };
        }
      } else if (path.includes('/comic/pages/')) {
        result = { status: 403, body: { err: 'user.no_permission' } };
      } else if (/\/api\/book\/\d+$/.test(path)) {
        result.body = { err: 'ok', book: books.find(book => path.endsWith(`/${book.id}`)) };
      } else if (path === '/api/shelf' || path === '/api/library' || path === '/api/search') {
        result.body = { err: 'ok', books, total: books.length };
      } else if (path.endsWith('/readstate')) {
        result.body = { err: 'ok', wants: true, download: 0 };
      } else if (path.endsWith('/progress')) {
        // Progress is optional and must never redirect the foreground page.
        result.body = { err: 'user.need_login', msg: '请先登录' };
      } else if (path === '/api/welcome') {
        result.body = { err: 'not_invited' };
      } else if (path === '/api/user/info') {
        result.body = { err: 'ok', user: { id: 1, is_login: true, username: 'fixture-reader', extra: {} }, sys: { title: '登录导航测试书库' } };
      } else if (path === '/api/book/nav') {
        result.body = { err: 'ok', navs: [] };
      } else if (path === '/api/network/sources') {
        result.body = { err: 'ok', items: [] };
      }
      return { ...result, body: new TextEncoder().encode(JSON.stringify(result.body)), headers: [['content-type', 'application/json']] };
    };
    window.__AUTH_TEST_REQUESTS__ = httpRequests;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command, args = {}) => {
        if (command === 'plugin:http|fetch') {
          const id = nextId++;
          requests.set(id, args.clientConfig);
          httpRequests.push(args.clientConfig.url);
          return id;
        }
        if (command === 'plugin:http|fetch_send') {
          const url = requests.get(args.rid).url;
          if (deferFailure && /\/api\/book\/\d+\.(epub|cbz)$/.test(new URL(url).pathname)) await failureGate;
          const response = responseFor(url);
          const rid = nextId++;
          bodies.set(rid, { ...response, sent: false });
          return { status: response.status, statusText: 'Fixture', url, rid, headers: response.headers };
        }
        if (command === 'plugin:http|fetch_read_body') {
          const response = bodies.get(args.rid);
          if (!response || response.sent) { bodies.delete(args.rid); return [1]; }
          response.sent = true;
          if (response.broken) throw new Error('error decoding response body');
          const bytes = new Uint8Array(response.body.length + 1);
          bytes.set(response.body);
          return bytes;
        }
        if (command.startsWith('plugin:http|fetch_cancel')) return null;
        if (command === 'plugin:event|listen') return nextId++;
        if (command === 'moke_runtime_platform' || command === 'plugin:os|platform') return 'linux';
        if (command === 'moke_list_downloaded_books' || command === 'ext_list_extensions') return [];
        if (command === 'plugin:path|resolve_directory') return '/app-data';
        if (command === 'plugin:path|join') return args.paths.join('/').replace(/\/+/g, '/');
        if (command === 'plugin:path|dirname') return args.path.slice(0, args.path.lastIndexOf('/'));
        if (command === 'plugin:fs|exists') return files.has(args.path);
        if (command === 'plugin:fs|stat') {
          if (!files.has(args.path)) throw new Error('File not found');
          return { isFile: true, size: files.get(args.path).length };
        }
        if (command === 'plugin:fs|open') {
          if (args.options?.truncate || !files.has(args.path)) files.set(args.path, new Uint8Array());
          const id = nextId++;
          handles.set(id, { path: args.path, position: 0 });
          return id;
        }
        if (command === 'plugin:fs|write') {
          const handle = handles.get(args.rid);
          const previous = files.get(handle.path);
          const bytes = new Uint8Array(handle.position + args.data.length);
          bytes.set(previous.subarray(0, bytes.length));
          bytes.set(args.data, handle.position);
          files.set(handle.path, bytes);
          handle.position += args.data.length;
          return args.data.length;
        }
        if (command === 'plugin:fs|read') {
          const handle = handles.get(args.rid);
          const content = files.get(handle.path).slice(handle.position, handle.position + args.len);
          handle.position += content.length;
          const bytes = new Uint8Array(content.length + 8);
          bytes.set(content);
          new DataView(bytes.buffer).setBigUint64(content.length, BigInt(content.length));
          return bytes.buffer;
        }
        if (command === 'plugin:fs|seek') { handles.get(args.rid).position = args.offset; return args.offset; }
        if (command === 'plugin:fs|remove') { files.delete(args.path); return null; }
        if (command === 'plugin:native-bridge|get_safe_area_insets') return { top: 0 };
        return null;
      },
      transformCallback: () => nextId++, unregisterCallback: () => {}, convertFileSrc: path => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    localStorage.setItem('moke-privacy-consent', '2026-08-14');
    if (!localStorage.getItem('moke-server-storage')) localStorage.setItem('moke-server-storage', JSON.stringify({ state: {
      serverUrl, offlineMode: false, hasHydrated: true, isConnected: true,
      user: { id: 1, username: 'fixture-reader' },
      capabilities: { annotationApiStatus: 'unsupported', annotationApiCheckedAt: Date.now(),
        shelfApi: true, networkSourcesApi: true, readingStateApi: true,
        readingProgressApi: true, readingStatsApi: true, checkedAt: Date.now() },
    }, version: 0 }));
    localStorage.setItem('moke-settings', JSON.stringify({ state: { readerPreference: 'embedded' }, version: 0 }));
    if (pausedDownloads && !localStorage.getItem('moke-offline-download-tasks-v1')) {
      localStorage.setItem('moke-offline-download-tasks-v1', JSON.stringify(books.map(book => ({
        key: `${serverUrl}::${book.id}::${format}`, serverUrl, bookId: book.id, title: book.title,
        format, status: 'paused', progress: 0, downloadedBytes: 0, updatedAt: Date.now(),
      }))));
    }
  }, { serverUrl: AUTH_SERVER_URL, failure, comic, pausedDownloads, deferFailure });
}
