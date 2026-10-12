import { installLibraryLayoutMock, LAYOUT_BOOK, LAYOUT_OFFLINE_BOOK, LAYOUT_SERVER_URL } from './library-layout.mjs';

export const REVALIDATION_DETAIL = `/detail?id=42&source=${encodeURIComponent(LAYOUT_SERVER_URL)}`;

// Real document history, with an explicit IPC gate for the returning query.
export async function installDetailRevalidationMock(page, { offlineMode = true, outcome = 'ok' } = {}) {
  await installLibraryLayoutMock(page, {
    offlineMode, nativeRuntime: 'android', nativeNavigation: true,
    nativeBooks: [LAYOUT_OFFLINE_BOOK],
    returnBookPayload: outcome === 'permission' ? { err: 'user.need_login' } : null,
  });
  await page.route('**/readest/reader?**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta charset="utf-8"><h1>模拟阅读器</h1><script>sessionStorage.setItem("returning", "true")</script>',
  }));
  await page.addInitScript(({ offlineMode, outcome }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const waiters = [], userWaiters = [];
    const requests = new Map(), bodies = new Map();
    let released = false, userReleased = false, userRequests = 0, rid = 7000;
    window.revalidation = {
      marker: Math.random(), pageshows: [], queries: 0, pending: false,
      userPending: false, userResponses: [],
      release: () => { released = true; waiters.splice(0).forEach((resolve) => resolve()); },
      releaseUser: () => { userReleased = true; userWaiters.splice(0).forEach((resolve) => resolve()); },
    };
    window.addEventListener('pageshow', (event) => window.revalidation.pageshows.push(event.persisted));
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (outcome === 'account' && command === 'plugin:http|fetch'
        && new URL(args.clientConfig.url).pathname === '/api/user/info') {
        const id = rid++;
        // The explicit Welcome validation precedes Provider discovery. It
        // must complete so the test can establish a real runtime connection.
        requests.set(id, { url: args.clientConfig.url, validation: ++userRequests === 1 });
        return id;
      }
      if (command === 'plugin:http|fetch_send' && requests.has(args.rid)) {
        const { url, validation } = requests.get(args.rid);
        if (!validation && !userReleased) {
          window.revalidation.userPending = true;
          await new Promise((resolve) => userWaiters.push(resolve));
        }
        const userId = validation ? 1 : 2;
        const id = rid++;
        bodies.set(id, JSON.stringify({ err: 'ok', user: {
          id: userId, is_login: true, username: validation ? 'layout-test' : 'fixture-two', extra: {},
        }, sys: { title: '布局测试书库' } }));
        window.revalidation.userResponses.push({ phase: validation ? 'validation' : 'provider', userId });
        return { status: 200, statusText: 'OK', url, rid: id, headers: [['content-type', 'application/json']] };
      }
      if (command === 'plugin:http|fetch_read_body' && bodies.has(args.rid)) {
        const body = bodies.get(args.rid); bodies.delete(args.rid);
        return [...new TextEncoder().encode(body), 0];
      }
      const query = offlineMode ? command === 'moke_list_downloaded_books'
        : command === 'plugin:http|fetch' && args.clientConfig.url.endsWith('/api/book/42');
      if (query) {
        window.revalidation.queries++;
        if (sessionStorage.getItem('returning') && !released) {
          window.revalidation.pending = true;
          await new Promise((resolve) => waiters.push(resolve));
          if (outcome === 'missing') return [];
          if (outcome === 'error') throw new Error('fixture detail revalidation failed');
        }
      }
      return invoke(command, args);
    };
  }, { offlineMode, outcome });
}

// Complete useful annotation data before delaying the book revalidation.
export async function installReadyAnnotationsMock(page, { deferFirstPost = false } = {}) {
  await page.addInitScript(({ deferFirstPost }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const requests = new Map(), bodies = new Map();
    let rid = 8000;
    const annotation = {
      id: 7, book_id: 42, annotation_type: 'note', client_id: 'fixture-note',
      cfi: 'epubcfi(/6/2!/4/2)', chapter: '虚构章节', content: '虚构标注',
      quote_text: '', color: '', author_name: '', is_private: true, sources: [],
      created_at: null, updated_at: null, user_modified_at: null,
    };
    let releasePost;
    window.annotationRace = { gets: 0, posts: 0, opens: 0, releasePost: () => releasePost?.() };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'plugin:http|fetch' && args.clientConfig.url.endsWith('/annotations')) {
        const id = rid++; requests.set(id, args.clientConfig); return id;
      }
      if (command === 'plugin:http|fetch_send' && requests.has(args.rid)) {
        const req = requests.get(args.rid), id = rid++;
        const post = req.method === 'POST';
        window.annotationRace[post ? 'posts' : 'gets']++;
        if (post && deferFirstPost && window.annotationRace.posts === 1) {
          await new Promise((resolve) => { releasePost = resolve; });
          bodies.set(id, JSON.stringify({ err: 'fixture.retry', msg: 'retry later' }));
          return { status: 429, statusText: 'Too Many Requests', url: req.url, rid: id, headers: [['content-type', 'application/json']] };
        }
        bodies.set(id, JSON.stringify(post
          ? { err: 'ok', annotation: { ...annotation, id: 8, content: '返回后保存' }, created: true }
          : { err: 'ok', annotations: [annotation] }));
        return { status: 200, statusText: 'OK', url: req.url, rid: id, headers: [['content-type', 'application/json']] };
      }
      if (command === 'plugin:http|fetch_read_body' && bodies.has(args.rid)) {
        const body = bodies.get(args.rid); bodies.delete(args.rid);
        return [...new TextEncoder().encode(body), 0];
      }
      if (command === 'moke_navigate' || command === 'open_reader') window.annotationRace.opens++;
      return invoke(command, args);
    };
  }, { deferFirstPost });
}

// Release the server's account response only once Reader preparation is pending.
export async function installAccountCancellationMock(page, { fail = false } = {}) {
  await installLibraryLayoutMock(page, { offlineMode: false, nativeRuntime: 'android', nativeBooks: [LAYOUT_OFFLINE_BOOK] });
  await page.addInitScript(({ fail }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const requests = new Map(), bodies = new Map(), users = [], platforms = [];
    const bookRids = new Set(), bookBodies = new Set();
    let rid = 9000, userReleased = false, platformReleased = false, userRequests = 0;
    window.__TAURI_OS_PLUGIN_INTERNALS__ = { get platform() {
      if (fail && platformReleased) throw new Error('fixture platform failure');
      return 'android';
    } };
    window.accountRace = {
      pending: false, settled: 0, bookResponses: 0, opens: [], userResponses: [],
      releaseUser: () => { userReleased = true; users.splice(0).forEach((resolve) => resolve()); },
      releasePlatform: () => { platformReleased = true; platforms.splice(0).forEach((resolve) => resolve()); },
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'plugin:http|fetch' && new URL(args.clientConfig.url).pathname === '/api/user/info') {
        const id = rid++;
        requests.set(id, { url: args.clientConfig.url, validation: ++userRequests === 1 });
        return id;
      }
      // Give the real connected shelf and its background Provider discovery
      // time to mount before book data starts the suspended opener.
      if (command === 'plugin:http|fetch' && args.clientConfig.url.endsWith('/api/book/42')) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (command === 'plugin:http|fetch_send' && requests.has(args.rid)) {
        const { url, validation } = requests.get(args.rid);
        if (!validation && !userReleased) await new Promise((resolve) => users.push(resolve));
        const id = rid++;
        const userId = validation ? 1 : 2;
        bodies.set(id, JSON.stringify({ err: 'ok', user: {
          id: userId, is_login: true, username: validation ? 'layout-test' : 'fixture-two', extra: {},
        }, sys: { title: '布局测试书库' } }));
        window.accountRace.userResponses.push({ phase: validation ? 'validation' : 'provider', userId });
        return { status: 200, statusText: 'OK', url, rid: id, headers: [['content-type', 'application/json']] };
      }
      if (command === 'plugin:http|fetch_read_body' && bodies.has(args.rid)) {
        const body = bodies.get(args.rid); bodies.delete(args.rid); return [...new TextEncoder().encode(body), 0];
      }
      // URL consumption precedes preparation; the spec additionally confirms
      // the visible progress stage before releasing the held user response.
      if (command === 'moke_runtime_platform' && location.pathname === '/detail'
        && !location.search.includes('continue=1')) {
        window.accountRace.pending = true;
        if (!platformReleased) await new Promise((resolve) => platforms.push(resolve));
        window.accountRace.settled++;
        if (fail) throw new Error('fixture delayed platform failure');
      }
      if (command === 'moke_navigate' || command === 'open_reader') {
        window.accountRace.opens.push({ command, args }); return null;
      }
      const result = await invoke(command, args);
      if (command === 'plugin:http|fetch' && args.clientConfig.url.endsWith('/api/book/42')) bookRids.add(result);
      if (command === 'plugin:http|fetch_send' && bookRids.has(args.rid)) bookBodies.add(result.rid);
      if (command === 'plugin:http|fetch_read_body' && bookBodies.has(args.rid) && result.length > 1) {
        window.accountRace.bookResponses++; bookBodies.delete(args.rid);
      }
      return result;
    };
  }, { fail });
}

export { LAYOUT_BOOK };
