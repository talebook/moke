import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOfflineDownloadSnapshot,
  listOfflineDownloadSnapshots,
  pauseOfflineDownload,
  removeOfflineDownloadSnapshot,
  startOfflineDownload,
  subscribeOfflineDownload,
  subscribeOfflineDownloads,
} from '../src/lib/offline-download-manager.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

test('离线下载不依赖详情页订阅者生命周期', async () => {
  const write = deferred();
  const key = 'https://example.test::39';
  const updates = [];

  const download = startOfflineDownload({
    key,
    run: async (onProgress) => {
      onProgress(25);
      await write.promise;
    },
  });
  const unsubscribe = subscribeOfflineDownload(key, (state) => updates.push(state));
  unsubscribe();

  assert.equal(getOfflineDownloadSnapshot(key)?.status, 'downloading');
  write.resolve();
  await download;
  assert.equal(getOfflineDownloadSnapshot(key)?.status, 'completed');
  assert.equal(updates.at(-1)?.progress, 25);
});

test('暂停会中止写入并保留已下载字节供继续', async () => {
  const key = 'https://example.test::resume::epub';
  let writes = 0;
  const download = startOfflineDownload({
    key,
    metadata: { serverUrl: 'https://example.test', bookId: 'resume', title: '恢复', format: 'epub' },
    run: async (_onProgress, signal, onTransfer) => {
      onTransfer(128, 1024);
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')), { once: true });
      });
      writes += 1;
    },
  });
  assert.equal(pauseOfflineDownload(key), true);
  await download;
  assert.equal(writes, 0);
  assert.equal(getOfflineDownloadSnapshot(key)?.status, 'paused');
  assert.equal(getOfflineDownloadSnapshot(key)?.downloadedBytes, 128);
});

test('异常退出后持久化中的任务恢复为可继续的暂停状态', () => {
  const storage = new Map([['moke-offline-download-tasks-v1', JSON.stringify([{
    key: 'https://recover.test::1::epub', serverUrl: 'https://recover.test', bookId: '1',
    title: '恢复任务', format: 'epub', status: 'downloading', progress: 42, downloadedBytes: 420,
  }])]]);
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  const [restored] = listOfflineDownloadSnapshots('https://recover.test');
  assert.equal(restored.status, 'paused');
  assert.equal(restored.downloadedBytes, 420);
  assert.match(String(restored.error), /异常退出/);
  delete globalThis.window;
});

test('大量 chunk 的持久化和全局刷新有固定上限且终态不会丢失', async () => {
  const key = 'https://chunks.test::large::epub';
  const storage = new Map();
  let storageWrites = 0;
  globalThis.window = {
    localStorage: {
      getItem: (storageKey) => storage.get(storageKey) ?? null,
      setItem: (storageKey, value) => {
        storageWrites += 1;
        storage.set(storageKey, value);
      },
    },
  };

  let taskRefreshes = 0;
  let recordRefreshes = 0;
  const events = [];
  const unsubscribe = subscribeOfflineDownloads((event) => {
    if (event.key !== key) return;
    events.push(event);
    taskRefreshes += 1;
    if (event.affectsRecords) recordRefreshes += 1;
  });

  const chunkCount = 10_000;
  await startOfflineDownload({
    key,
    metadata: {
      serverUrl: 'https://chunks.test', bookId: 'large', title: '大文件', format: 'epub', totalBytes: chunkCount,
    },
    run: async (onProgress, _signal, onTransfer) => {
      for (let received = 1; received <= chunkCount; received += 1) {
        onTransfer(received, chunkCount);
        onProgress(Math.min(99, Math.round(received / chunkCount * 100)));
      }
    },
  });
  unsubscribe();

  // Hydration may add one write; 20,000 chunk callbacks add none before the immediate terminal flush.
  assert.ok(storageWrites <= 3, `expected at most 3 localStorage writes, got ${storageWrites}`);
  assert.ok(taskRefreshes <= 2, `expected at most 2 task refreshes, got ${taskRefreshes}`);
  assert.equal(recordRefreshes, 1);
  assert.deepEqual(events.map((event) => event.kind), ['progress', 'terminal']);
  assert.deepEqual(events.map((event) => event.affectsRecords), [false, true]);

  const finalSnapshot = getOfflineDownloadSnapshot(key);
  assert.equal(finalSnapshot?.status, 'completed');
  assert.equal(finalSnapshot?.progress, 100);
  assert.equal(finalSnapshot?.downloadedBytes, chunkCount);
  const persisted = JSON.parse(storage.get('moke-offline-download-tasks-v1'));
  assert.equal(persisted.find((snapshot) => snapshot.key === key)?.status, 'completed');
  assert.equal(persisted.find((snapshot) => snapshot.key === key)?.downloadedBytes, chunkCount);
  delete globalThis.window;
});

test('同一本书复用在途下载任务', async () => {
  const write = deferred();
  const key = 'https://example.test::40';
  let runs = 0;
  const options = {
    key,
    run: async () => {
      runs += 1;
      await write.promise;
    },
  };

  const first = startOfflineDownload(options);
  const second = startOfflineDownload(options);
  assert.equal(first, second);
  assert.equal(runs, 1);

  write.resolve();
  await first;
});

test('删除运行中任务会等待取消清理且不会重新发布失败快照', async () => {
  const cleanup = deferred();
  const key = 'https://example.test::remove-active::epub';
  let cleanupCalls = 0;

  startOfflineDownload({
    key,
    metadata: { serverUrl: 'https://example.test', bookId: 'remove-active', title: '删除中', format: 'epub' },
    run: async (_onProgress, signal, onTransfer) => {
      onTransfer(256, 1024);
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    },
    onCancel: async () => {
      cleanupCalls += 1;
      await cleanup.promise;
    },
  });

  let removed = false;
  const firstRemoval = removeOfflineDownloadSnapshot(key).then(() => { removed = true; });
  const secondRemoval = removeOfflineDownloadSnapshot(key);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cleanupCalls, 1);
  assert.equal(removed, false);
  cleanup.resolve();
  await Promise.all([firstRemoval, secondRemoval]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cleanupCalls, 1);
  assert.equal(getOfflineDownloadSnapshot(key), undefined);
  assert.equal(listOfflineDownloadSnapshots().some((snapshot) => snapshot.key === key), false);
});
