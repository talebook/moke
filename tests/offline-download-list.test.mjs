import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateOfflineDownloadUsedBytes,
  mergeOfflineDownloadItems,
} from '../src/lib/offline-download-list.ts';

const record = {
  id: 'https://example.test::stale::epub',
  serverUrl: 'https://example.test',
  bookId: 'stale',
  format: 'epub',
  title: '旧记录',
  fileName: '旧记录.epub',
  mimeType: 'application/epub+zip',
  size: 1024,
  updatedAt: 10,
};

test('已有记录重新下载时保留任务状态和控制所需进度', () => {
  for (const status of ['downloading', 'paused', 'failed', 'cancelled']) {
    const task = {
      key: record.id,
      serverUrl: record.serverUrl,
      bookId: record.bookId,
      format: record.format,
      title: '重新下载',
      status,
      progress: 25,
      downloadedBytes: 256,
      totalBytes: 2048,
      updatedAt: 20,
    };

    const [item] = mergeOfflineDownloadItems([record], [task], new Set([record.id]));
    assert.equal(item.status, status);
    assert.equal(item.progress, 25);
    assert.equal(item.downloadedBytes, 256);
    assert.equal(item.title, '重新下载');
    assert.equal(item.record, record);
    assert.equal(item.stale, true);
  }
});

test('容量按合并后的 key 统计，不重复累加旧记录与在途字节', () => {
  const tasks = [
    {
      key: record.id,
      status: 'downloading',
      progress: 25,
      downloadedBytes: 256,
      updatedAt: 20,
    },
    {
      key: 'https://example.test::new::pdf',
      status: 'paused',
      progress: 50,
      downloadedBytes: 512,
      updatedAt: 30,
    },
  ];
  const items = mergeOfflineDownloadItems([record], tasks, new Set());

  assert.equal(items.length, 2);
  assert.equal(calculateOfflineDownloadUsedBytes(items), 768);
});

test('无活动任务时完成记录仍作为已下载项显示和计量', () => {
  const [item] = mergeOfflineDownloadItems([record], [], new Set());

  assert.equal(item.status, 'completed');
  assert.equal(item.progress, 100);
  assert.equal(item.downloadedBytes, record.size);
  assert.equal(calculateOfflineDownloadUsedBytes([item]), record.size);
});

test('stale 检测结果会保留在合并项且驱动旧版 stale 标志', () => {
  const freshness = new Map([[record.id, { status: 'stale' }]]);
  const [item] = mergeOfflineDownloadItems([record], [], new Set(), freshness);

  assert.equal(item.freshness, 'stale');
  assert.equal(item.stale, true);
});
