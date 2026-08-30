import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdateStore } from '../src/lib/store/update.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settleAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function useMemoryLocalStorage() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete globalThis.localStorage;
    }
  };
}

function makeUpdate(download, overrides = {}) {
  return {
    version: '1.2.0',
    currentVersion: '1.1.0',
    body: 'release notes',
    download,
    close: async () => {},
    install: async () => {},
    ...overrides,
  };
}

function createDesktopStore(importUpdater, sleep = async () => {}) {
  return createUpdateStore({
    importUpdater,
    resolvePlatform: async () => 'desktop',
    sleep,
  });
}

test('并发 checkForUpdates 共享同一次检查和下载，且进度不倒退', async () => {
  const checking = deferred();
  let checkCalls = 0;
  let downloadCalls = 0;
  const update = makeUpdate(async (onEvent) => {
    downloadCalls += 1;
    onEvent({ event: 'Started', data: { contentLength: 100 } });
    onEvent({ event: 'Progress', data: { chunkLength: 60 } });
    // Even a changed total must not make a later progress callback move backwards.
    onEvent({ event: 'Started', data: { contentLength: 200 } });
    onEvent({ event: 'Progress', data: { chunkLength: 10 } });
    onEvent({ event: 'Finished', data: {} });
  });
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      await checking.promise;
      return update;
    },
  }));
  const observedProgress = [];
  store.subscribe((state, previous) => {
    if (state.progressPercent !== previous.progressPercent) {
      observedProgress.push(state.progressPercent);
    }
  });

  const first = store.getState().checkForUpdates();
  const second = store.getState().checkForUpdates();
  assert.equal(first, second);
  await settleAsyncWork();
  assert.equal(checkCalls, 1);

  checking.resolve();
  await Promise.all([first, second]);

  assert.equal(checkCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(store.getState().status, 'downloaded');
  assert.ok(
    observedProgress.every((value, index) => index === 0 || value >= observedProgress[index - 1]),
    `progress moved backwards: ${observedProgress.join(', ')}`,
  );
});

test('自动检查与手动检查重叠时共享 single-flight，initialize 也只安排一次', async () => {
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  const startupDelay = deferred();
  const checking = deferred();
  let platformCalls = 0;
  let sleepCalls = 0;
  let checkCalls = 0;
  let downloadCalls = 0;
  const update = makeUpdate(async () => { downloadCalls += 1; });
  const store = createUpdateStore({
    resolvePlatform: async () => {
      platformCalls += 1;
      return 'desktop';
    },
    sleep: async (delayMs) => {
      sleepCalls += 1;
      assert.equal(delayMs, 5000);
      await startupDelay.promise;
    },
    importUpdater: async () => ({
      check: async () => {
        checkCalls += 1;
        await checking.promise;
        return update;
      },
    }),
  });

  try {
    const firstInitialize = store.getState().initialize();
    const secondInitialize = store.getState().initialize();
    await settleAsyncWork();
    assert.equal(platformCalls, 1);
    assert.equal(sleepCalls, 1);

    const manualCheck = store.getState().checkForUpdates();
    await settleAsyncWork();
    assert.equal(checkCalls, 1);

    startupDelay.resolve();
    await settleAsyncWork();
    assert.equal(checkCalls, 1);

    checking.resolve();
    await Promise.all([firstInitialize, secondInitialize, manualCheck]);
    assert.equal(checkCalls, 1);
    assert.equal(downloadCalls, 1);
  } finally {
    if (previousPlatform === undefined) {
      delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    } else {
      process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
    }
  }
});

test('手动检查在启动延时内完成后跳过后续自动检查', async () => {
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  const startupDelay = deferred();
  let checkCalls = 0;
  let downloadCalls = 0;
  const update = makeUpdate(async () => { downloadCalls += 1; });
  const store = createUpdateStore({
    resolvePlatform: async () => 'desktop',
    sleep: async () => { await startupDelay.promise; },
    importUpdater: async () => ({
      check: async () => {
        checkCalls += 1;
        return update;
      },
    }),
  });

  try {
    const initialization = store.getState().initialize();
    await settleAsyncWork();

    await store.getState().checkForUpdates();
    assert.equal(checkCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.equal(store.getState().status, 'downloaded');

    startupDelay.resolve();
    await initialization;
    assert.equal(checkCalls, 1);
    assert.equal(downloadCalls, 1);
  } finally {
    if (previousPlatform === undefined) {
      delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    } else {
      process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
    }
  }
});

test('后续检查仍查询 updater，但同版本复用已下载包', async () => {
  let checkCalls = 0;
  let downloadCalls = 0;
  let firstCloseCalls = 0;
  let duplicateCloseCalls = 0;
  const firstUpdate = makeUpdate(
    async () => { downloadCalls += 1; },
    { close: async () => { firstCloseCalls += 1; } },
  );
  const duplicateUpdate = makeUpdate(
    async () => { downloadCalls += 1; },
    { close: async () => { duplicateCloseCalls += 1; } },
  );
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      return checkCalls === 1 ? firstUpdate : duplicateUpdate;
    },
  }));
  const restoreLocalStorage = useMemoryLocalStorage();

  try {
    await store.getState().checkForUpdates();
    store.getState().dismissPrompt();
    store.setState({ checkedAt: 1 });
    await store.getState().checkForUpdates();

    assert.equal(checkCalls, 2);
    assert.equal(downloadCalls, 1);
    assert.equal(firstCloseCalls, 0);
    assert.equal(duplicateCloseCalls, 1);
    assert.equal(store.getState().status, 'downloaded');
    assert.equal(store.getState().shouldPrompt, false);
    assert.ok(store.getState().checkedAt > 1);
  } finally {
    restoreLocalStorage();
  }
});

test('已下载后检查到更新版本会关闭旧包并下载新包', async () => {
  let checkCalls = 0;
  let firstDownloadCalls = 0;
  let nextDownloadCalls = 0;
  let firstCloseCalls = 0;
  const firstUpdate = makeUpdate(
    async () => { firstDownloadCalls += 1; },
    { close: async () => { firstCloseCalls += 1; } },
  );
  const nextUpdate = makeUpdate(
    async () => { nextDownloadCalls += 1; },
    { version: '1.3.0' },
  );
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      return checkCalls === 1 ? firstUpdate : nextUpdate;
    },
  }));

  await store.getState().checkForUpdates();
  await store.getState().checkForUpdates();

  assert.equal(checkCalls, 2);
  assert.equal(firstDownloadCalls, 1);
  assert.equal(nextDownloadCalls, 1);
  assert.equal(firstCloseCalls, 1);
  assert.equal(store.getState().availableVersion, '1.3.0');
  assert.equal(store.getState().status, 'downloaded');
});

test('自动下载进行中调用 installUpdate 会等待下载后继续安装', async () => {
  const downloadStarted = deferred();
  const finishDownload = deferred();
  let downloadCalls = 0;
  let installCalls = 0;
  let relaunchCalls = 0;
  const update = makeUpdate(
    async () => {
      downloadCalls += 1;
      downloadStarted.resolve();
      await finishDownload.promise;
    },
    { install: async () => { installCalls += 1; } },
  );
  const store = createUpdateStore({
    importUpdater: async () => ({ check: async () => update }),
    importProcess: async () => ({
      relaunch: async () => {
        relaunchCalls += 1;
        throw new Error('test relaunch');
      },
    }),
    resolvePlatform: async () => 'desktop',
    sleep: async () => {},
  });

  const automaticDownload = store.getState().checkForUpdates();
  await downloadStarted.promise;
  let installationSettled = false;
  const installation = store.getState().installUpdate().then(() => {
    installationSettled = true;
  });
  await settleAsyncWork();

  assert.equal(downloadCalls, 1);
  assert.equal(installCalls, 0);
  assert.equal(installationSettled, false);

  finishDownload.resolve();
  await Promise.all([automaticDownload, installation]);
  assert.equal(downloadCalls, 1);
  assert.equal(installCalls, 1);
  assert.equal(relaunchCalls, 1);
  assert.equal(store.getState().status, 'downloaded');
  assert.match(store.getState().error, /test relaunch/);
});

test('initialize 准备失败后允许后续调用重试', async () => {
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  let platformCalls = 0;
  let sleepCalls = 0;
  let checkCalls = 0;
  const store = createUpdateStore({
    resolvePlatform: async () => {
      platformCalls += 1;
      return 'desktop';
    },
    sleep: async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) throw new Error('startup sleep failed');
    },
    importUpdater: async () => ({
      check: async () => {
        checkCalls += 1;
        return null;
      },
    }),
  });

  try {
    await store.getState().initialize();
    await store.getState().initialize();

    assert.equal(platformCalls, 2);
    assert.equal(sleepCalls, 2);
    assert.equal(checkCalls, 1);
    assert.equal(store.getState().status, 'up-to-date');
  } finally {
    if (previousPlatform === undefined) {
      delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    } else {
      process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
    }
  }
});

test('无更新时会释放 single-flight，后续检查仍会执行', async () => {
  let checkCalls = 0;
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      return null;
    },
  }));

  await store.getState().checkForUpdates();
  await store.getState().checkForUpdates();

  assert.equal(checkCalls, 2);
  assert.equal(store.getState().status, 'up-to-date');
});

test('检查异常会释放 single-flight，后续手动重试可成功下载', async () => {
  let checkCalls = 0;
  let downloadCalls = 0;
  const update = makeUpdate(async () => { downloadCalls += 1; });
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      if (checkCalls === 1) throw new Error('check failed');
      return update;
    },
  }));

  await store.getState().checkForUpdates();
  assert.equal(store.getState().status, 'error');
  assert.match(store.getState().error, /check failed/);

  await store.getState().checkForUpdates();
  assert.equal(checkCalls, 2);
  assert.equal(downloadCalls, 1);
  assert.equal(store.getState().status, 'downloaded');
  assert.equal(store.getState().error, null);
});

test('下载异常后可重新检查并重试下载', async () => {
  let checkCalls = 0;
  let downloadCalls = 0;
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      return makeUpdate(async () => {
        downloadCalls += 1;
        if (downloadCalls === 1) throw new Error('download failed');
      });
    },
  }));

  await store.getState().checkForUpdates();
  assert.equal(store.getState().status, 'available');
  assert.match(store.getState().error, /download failed/);

  await store.getState().checkForUpdates();
  assert.equal(checkCalls, 2);
  assert.equal(downloadCalls, 2);
  assert.equal(store.getState().status, 'downloaded');
  assert.equal(store.getState().error, null);
});
