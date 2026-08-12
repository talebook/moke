import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOfflineDownloadSnapshot,
  startOfflineDownload,
  subscribeOfflineDownload,
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
