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

function makeUpdate(download) {
  return {
    version: '1.2.0',
    currentVersion: '1.1.0',
    body: 'release notes',
    download,
    close: async () => {},
    install: async () => {},
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

test('已下载的更新在后续手动检查中复用', async () => {
  let checkCalls = 0;
  let downloadCalls = 0;
  let closeCalls = 0;
  const update = {
    ...makeUpdate(async () => { downloadCalls += 1; }),
    close: async () => { closeCalls += 1; },
  };
  const store = createDesktopStore(async () => ({
    check: async () => {
      checkCalls += 1;
      return update;
    },
  }));

  await store.getState().checkForUpdates();
  await store.getState().checkForUpdates();

  assert.equal(checkCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(closeCalls, 0);
  assert.equal(store.getState().status, 'downloaded');
});

test('自动下载进行中调用 installUpdate 不会并发下载同一更新', async () => {
  const downloadStarted = deferred();
  const finishDownload = deferred();
  let downloadCalls = 0;
  const update = makeUpdate(async () => {
    downloadCalls += 1;
    downloadStarted.resolve();
    await finishDownload.promise;
  });
  const store = createDesktopStore(async () => ({ check: async () => update }));

  const automaticDownload = store.getState().checkForUpdates();
  await downloadStarted.promise;
  await store.getState().installUpdate();
  assert.equal(downloadCalls, 1);

  finishDownload.resolve();
  await automaticDownload;
  assert.equal(downloadCalls, 1);
  assert.equal(store.getState().status, 'downloaded');
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
