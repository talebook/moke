import { installLibraryLayoutMock, LAYOUT_OFFLINE_BOOK } from './library-layout.mjs';

export const SECOND_BOOK = {
  ...LAYOUT_OFFLINE_BOOK,
  id: `${LAYOUT_OFFLINE_BOOK.serverUrl}::43::epub`,
  bookId: '43', title: '第二本取消回归书籍', filePath: '/test-data/second.epub',
};

// Delay real frontend IPC promises without navigating away from their document.
// Keep both native calls and router fallbacks observable after releasing them.
export async function installReaderCancellationMock(page, {
  entry = 'detail', runtime = 'android', delay = 'platform',
  slowBack = false,
} = {}) {
  await installLibraryLayoutMock(page, {
    offlineMode: true, startup: entry === 'startup', nativeRuntime: runtime,
    nativeBooks: [LAYOUT_OFFLINE_BOOK, SECOND_BOOK],
  });
  await page.route('**/readest/reader?**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<!doctype html><h1>模拟阅读器就绪</h1>',
  }));
  if (slowBack) {
    await page.route('**/shelf?*', async (route) => {
      // Hold the destination RSC longer than Home's 1.5s safety timer.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });
  }
  await page.addInitScript(({ entry, runtime, delay }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const pending = [];
    const released = new Map();
    // Current plugin-os reads a synchronous injected property, not an IPC.
    // Deliberately fail that compatibility branch when releasing failed probes.
    window.__TAURI_OS_PLUGIN_INTERNALS__ = {
      get platform() {
        if ([...released.values()].some(Boolean)) throw new Error('fixture platform fallback failure');
        return runtime;
      },
    };
    const race = window.readerRace = {
      calls: [], pending: [], settled: [],
      release: (key, fail = false) => {
        released.set(key, fail);
        for (const item of pending.splice(0)) {
          if (item.key !== key) { pending.push(item); continue; }
          if (fail) item.reject(new Error('fixture delayed IPC failure'));
          else item.resolve(runtime);
        }
      },
    };
    const addListener = window.addEventListener.bind(window);
    const removeListener = window.removeEventListener.bind(window);
    const backListeners = new Set();
    window.addEventListener = (name, listener, options) => {
      addListener(name, listener, options);
      if (name === 'moke:native-back') backListeners.add(listener);
      race.backReady = backListeners.size > 0;
    };
    window.removeEventListener = (name, listener, options) => {
      removeListener(name, listener, options);
      if (name === 'moke:native-back') backListeners.delete(listener);
      race.backReady = backListeners.size > 0;
    };
    const hold = async (key) => {
      race.pending.push(key);
      try {
        if (released.has(key)) {
          if (released.get(key)) throw new Error('fixture delayed IPC failure');
          return runtime;
        }
        return await new Promise((resolve, reject) => pending.push({ key, resolve, reject }));
      } finally { race.settled.push(key); }
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const from = location.pathname + location.search;
      const key = location.pathname === '/' ? 'startup' : new URLSearchParams(location.search).get('id');
      if (command === 'moke_navigate' || command === 'open_reader' || command === 'moke_open_downloaded_book') {
        race.calls.push({ command, args, from });
        if (delay === 'navigation' && command === 'moke_navigate') return hold(key);
        // Record the navigation but keep this document available for assertions.
        return null;
      }
      if (delay === 'platform' && (command === 'moke_runtime_platform' || command === 'plugin:os|platform')
        && location.pathname === (entry === 'startup' ? '/' : '/detail')) {
        // Qualification/providers must settle before the opener gate. Observe
        // real UI stages rather than function names erased by production builds.
        // React may not have painted the stage set immediately before IPC yet.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const stage = document.querySelector('[data-testid="app-startup-screen"]')?.getAttribute('data-progress-message');
        const preparing = entry === 'startup'
          ? ['正在读取阅读记录…', '正在打开上次阅读的书籍…'].includes(stage)
          : !location.search.includes('continue=1') && [
            '正在恢复阅读进度…', '正在读取书籍并恢复阅读进度…',
          ].includes(stage);
        if (!preparing) return invoke(command, args);
        race.openerPending = key;
        return hold(key);
      }
      return invoke(command, args);
    };
  }, { entry, runtime, delay });
}

export async function releaseReaderIPC(page, key, fail = false) {
  await page.evaluate(({ key, fail }) => window.readerRace.release(key, fail), { key, fail });
  await page.waitForFunction((key) => location.pathname.startsWith('/readest/') || window.readerRace.settled.includes(key), key);
  // Also allow the importer/router continuation to run after IPC settlement.
  // Startup cases wait past the 1.5s router safety timer in their spec.
  await page.waitForTimeout(250);
}
