import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOfflineLibrary } from '../src/lib/offline-library.ts';

test('离线书库按服务器和书籍聚合多种格式并保留最近更新时间', () => {
  const records = [
    { serverUrl: 'https://a.test', bookId: '1', title: '书 A', author: '作者', format: 'epub', size: 10, updatedAt: 1000 },
    { serverUrl: 'https://a.test', bookId: '1', title: '书 A', author: '作者', format: 'pdf', size: 20, updatedAt: 3000 },
    { serverUrl: 'https://b.test', bookId: '1', title: '书 B', format: 'epub', size: 30, updatedAt: 2000 },
  ].map((record) => ({ ...record, id: `${record.serverUrl}::${record.bookId}::${record.format}`, fileName: '', mimeType: '' }));

  const books = buildOfflineLibrary(records);
  assert.equal(books.length, 2);
  assert.equal(books[0].title, '书 A');
  assert.deepEqual(books[0].files, [{ format: 'epub', size: 10 }, { format: 'pdf', size: 20 }]);
  assert.equal(books[0].timestamp, 3);
});
