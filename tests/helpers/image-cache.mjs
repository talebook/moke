import { installLibraryLayoutMock, LAYOUT_SERVER_URL } from './library-layout.mjs';

export async function installCoverQueueMock(page) {
  await installLibraryLayoutMock(page, { bookCount: 6, continueReading: false });
  await page.addInitScript(({ serverUrl }) => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const requests = new Map();
    const bodies = new Map();
    const waiting = [];
    let nextId = 9000;
    let released = false;
    // Binary PNG also decodes when the plugin constructs a Response stream
    // before overriding its headers (blob MIME may then be empty).
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAEUlEQVR4nGPojtImiBhGFQEAIJ1mAeels6sAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    window.coverQueue = { started: [], cancelled: [], bodyCancelled: [] };
    window.releaseOldCovers = () => {
      released = true;
      waiting.splice(0).forEach((resolve) => resolve());
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'plugin:http|fetch') {
        const url = args.clientConfig.url;
        const id = await original(command, args);
        requests.set(id, url);
        if (url.includes('/covers/')) window.coverQueue.started.push(url);
        return id;
      }
      if (command === 'plugin:http|fetch_cancel' && requests.get(args.rid)?.includes('/covers/')) {
        window.coverQueue.cancelled.push(requests.get(args.rid));
        // Intentionally leave send pending to exercise a bridge ignoring abort.
        return null;
      }
      if (command === 'plugin:http|fetch_cancel_body' && bodies.has(args.rid)) {
        window.coverQueue.bodyCancelled.push(args.rid);
        return null;
      }
      if (command === 'plugin:http|fetch_send') {
        const url = requests.get(args.rid);
        const pathname = new URL(url).pathname;
        if (url.includes('/covers/')) {
          if (url.includes('/old-') && !released) await new Promise((resolve) => waiting.push(resolve));
          const rid = nextId++;
          bodies.set(rid, png);
          return { status: 200, statusText: 'OK', url, rid, headers: [['content-type', 'image/png']] };
        }
        const result = await original(command, args);
        if (pathname === '/api/shelf' || pathname === '/api/library') {
          const prefix = pathname === '/api/shelf' ? 'old' : 'new';
          bodies.set(result.rid, JSON.stringify({ err: 'ok', total: 6, books: Array.from({ length: 6 }, (_, i) => ({
            id: String(i + 1), title: `封面测试 ${i + 1}`, author: '虚构作者',
            files: [{ format: 'epub' }], state: { wants: true, download: 0 },
            img: `${serverUrl}/covers/${prefix}-${i}.png`,
          })) }));
        }
        return result;
      }
      if (command === 'plugin:http|fetch_read_body' && bodies.has(args.rid)) {
        const body = bodies.get(args.rid);
        bodies.set(args.rid, null);
        return body ? [...(typeof body === 'string' ? new TextEncoder().encode(body) : body), 0] : [1];
      }
      return original(command, args);
    };
  }, { serverUrl: LAYOUT_SERVER_URL });
}
