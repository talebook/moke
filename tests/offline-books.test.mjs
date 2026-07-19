import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deleteOfflineBook,
  getOfflineBook,
  saveOfflineBook,
} from '../src/lib/offline-books.ts';
import {
  makeOfflineBookKey,
  sanitizeOfflineFileName,
} from '../src/lib/offline-book-core.ts';

function makeAsyncRequest(operation) {
  const request = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };

  queueMicrotask(() => {
    try {
      request.result = operation();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });

  return request;
}

function createFakeIndexedDb() {
  const records = new Map();
  let storeCreated = false;

  const objectStore = {
    get(key) {
      return makeAsyncRequest(() => records.get(key));
    },
    put(record) {
      return makeAsyncRequest(() => {
        records.set(record.id, record);
        return record.id;
      });
    },
    delete(key) {
      return makeAsyncRequest(() => records.delete(key));
    },
  };

  const database = {
    objectStoreNames: {
      contains() {
        return storeCreated;
      },
    },
    createObjectStore() {
      storeCreated = true;
      return objectStore;
    },
    transaction() {
      return { objectStore: () => objectStore };
    },
  };

  return {
    records,
    open() {
      const request = {
        result: database,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      queueMicrotask(() => {
        if (!storeCreated) request.onupgradeneeded?.();
        request.onsuccess?.();
      });

      return request;
    },
  };
}

function installWebOfflineStore() {
  const indexedDB = createFakeIndexedDb();
  globalThis.window = { indexedDB };
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'web';
  return indexedDB;
}

test('离线书籍键会隔离不同服务器和书籍', () => {
  assert.equal(makeOfflineBookKey('https://a.example', '12'), 'https://a.example::12');
  assert.notEqual(
    makeOfflineBookKey('https://a.example', '12'),
    makeOfflineBookKey('https://b.example', '12'),
  );
});

test('离线文件名会清理系统不允许的字符', () => {
  assert.equal(sanitizeOfflineFileName('三体:全集?.epub.'), '三体_全集_.epub');
  assert.equal(sanitizeOfflineFileName('...'), 'book.epub');
});

test('网页版可以保存并重新读取离线书籍', async () => {
  installWebOfflineStore();
  const blob = new Blob(['book-data'], { type: 'application/epub+zip' });

  await saveOfflineBook({
    serverUrl: 'https://a.example',
    bookId: '42',
    title: '测试书籍',
    fileName: '测试:书籍?.epub',
    mimeType: 'application/epub+zip',
    blob,
  });

  const record = await getOfflineBook('https://a.example', '42');
  assert.ok(record);
  assert.equal(record.id, 'https://a.example::42');
  assert.equal(record.fileName, '测试_书籍_.epub');
  assert.equal(record.title, '测试书籍');
  assert.equal(await record.blob.text(), 'book-data');
  assert.equal(record.filePath, undefined);
  assert.equal(typeof record.updatedAt, 'number');
});

test('重复保存会更新原记录，多个服务器之间互不覆盖', async () => {
  const indexedDB = installWebOfflineStore();

  const save = (serverUrl, title) => saveOfflineBook({
    serverUrl,
    bookId: '7',
    title,
    fileName: `${title}.epub`,
    mimeType: 'application/epub+zip',
    blob: new Blob([title]),
  });

  await save('https://a.example', '旧标题');
  await save('https://a.example', '新标题');
  await save('https://b.example', '另一服务器');

  assert.equal(indexedDB.records.size, 2);
  assert.equal((await getOfflineBook('https://a.example', '7'))?.title, '新标题');
  assert.equal((await getOfflineBook('https://b.example', '7'))?.title, '另一服务器');
});

test('删除只移除目标离线书籍，删除不存在的记录也不会失败', async () => {
  installWebOfflineStore();

  for (const bookId of ['1', '2']) {
    await saveOfflineBook({
      serverUrl: 'https://a.example',
      bookId,
      title: `书籍 ${bookId}`,
      fileName: `${bookId}.epub`,
      mimeType: 'application/epub+zip',
      blob: new Blob([bookId]),
    });
  }

  await deleteOfflineBook('https://a.example', '1');
  await deleteOfflineBook('https://a.example', 'missing');

  assert.equal(await getOfflineBook('https://a.example', '1'), null);
  assert.equal((await getOfflineBook('https://a.example', '2'))?.bookId, '2');
});
