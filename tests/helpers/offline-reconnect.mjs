import { installLibraryLayoutMock, LAYOUT_OFFLINE_BOOK } from './library-layout.mjs';

export const RECONNECT_SERVER = 'https://previous.books.test';
export async function installOfflineReconnectMock(page, {
  offlineMode = false, serverUrl = RECONNECT_SERVER, mode = 'success',
  fallback = '', cachedUser = true,
} = {}) {
  await installLibraryLayoutMock(page, { continueReading: false, nativeBooks: [{ ...LAYOUT_OFFLINE_BOOK, serverUrl: RECONNECT_SERVER }] });
  await page.addInitScript(({ offlineMode, serverUrl, mode, fallback, cachedUser }) => {
    const state = JSON.parse(localStorage.getItem('moke-server-storage'));
    state.state = { ...state.state, offlineMode, serverUrl, isConnected: !offlineMode,
      token: 'fictional-token', user: cachedUser ? { id: 1, username: 'fixture-reader' } : null };
    localStorage.setItem('moke-server-storage', JSON.stringify(state));
    if (fallback) localStorage.setItem('moke_server_url', fallback);
    else localStorage.removeItem('moke_server_url');
    window.__MOKE_RECONNECT_FIXTURE__ = { mode, requests: [] };
    const original = window.__TAURI_INTERNALS__.invoke;
    const requests = new Map();
    const bodies = new Map();
    let nextId = 5000;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const fixture = window.__MOKE_RECONNECT_FIXTURE__;
      if (command === 'plugin:http|fetch') {
        const id = nextId++;
        requests.set(id, args.clientConfig.url);
        fixture.requests.push(args.clientConfig.url);
        return id;
      }
      if (command === 'plugin:http|fetch_send') {
        const url = requests.get(args.rid);
        const path = new URL(url).pathname;
        if (fixture.mode === 'hang') await new Promise((resolve) => { fixture.release = resolve; });
        if (fixture.mode === 'network') throw new Error('Fixture server unreachable');
        const info = fixture.mode === 'expired'
          ? { err: 'user.need_login', user: { is_login: false } }
          : { err: 'ok', user: { id: 1, username: 'fixture-reader', is_login: true }, sys: { title: '恢复测试书库', version: '3.15.0' } };
        const payload = path === '/api/user/info' ? info
          : path === '/api/welcome' ? { err: fixture.mode === 'access' ? 'ok' : 'not_invited' }
            : path === '/api/shelf' || path === '/api/library' ? { err: 'ok', books: [], total: 0 }
              : path === '/api/network/sources' ? { err: 'ok', items: [] } : { err: 'ok' };
        const id = nextId++;
        bodies.set(id, JSON.stringify(payload));
        return { status: 200, statusText: 'OK', url, rid: id, headers: [['content-type', 'application/json']] };
      }
      if (command === 'plugin:http|fetch_read_body') {
        const body = bodies.get(args.rid);
        bodies.delete(args.rid);
        return body ? [...new TextEncoder().encode(body), 0] : [1];
      }
      if (command.startsWith('plugin:http|fetch_cancel')) return null;
      return original(command, args);
    };
  }, { offlineMode, serverUrl, mode, fallback, cachedUser });
}
